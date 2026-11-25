import path from "node:path";
import { viewport } from "./catalog.mjs";
import { failure, openStdio } from "./transport.mjs";

export function planGoal(goal) {
  const entity = goal.match(/\b(invoice|team|ticket|order|entry|switch) [a-z\d-]+/i)?.[0]?.toLowerCase();
  const operation = [
    [/^(approve|authorize payment for) /i, "approve"], [/^(save|store the settings for|set the display name for) /i, "save"],
    [/^(assign|take ownership of) /i, "assign"], [/^(confirm|complete checkout for) /i, "confirm"],
    [/^(pin|keep at the top) /i, "pin"], [/^(enable|turn on) /i, "enable"],
  ].find(([pattern]) => pattern.test(goal))?.[1];
  if (!entity || !operation) throw failure("UNSUPPORTED_GOAL", "The deterministic driver could not interpret this goal");
  return { entity, operation, value: goal.match(/\bto “([^”]+)”/u)?.[1] ?? null };
}

const normalize = label => String(label).trim().toLowerCase().replace(/\s+/g, " ");

export function chooseActions(plan, candidates) {
  const select = (role, name) => {
    const matches = candidates.filter(candidate => candidate.role === role && !candidate.disabled && normalize(candidate.label) === name);
    if (matches.length > 1) throw failure("AMBIGUOUS_TARGET", `More than one observed ${role} matches the goal`);
    if (!matches.length) throw failure("TARGET_MISSING", `No observed ${role} matches the goal`);
    return matches[0].target;
  };
  const click = select("button", `${plan.operation} ${plan.entity}`);
  if (plan.value === null) return [{ action: "click", target: click }];
  return [{ action: "fill", target: select("field", `display name for ${plan.entity}`), value: plan.value }, { action: "click", target: click }];
}

export function nativeCandidates(view) {
  return String(view ?? "").split("\n").flatMap(line => {
    const match = /^\s*(?:[+~]\s*)?\[(\d+)\] (button|field) ("(?:[^"\\]|\\.)*")/.exec(line);
    if (!match) return [];
    return [{ target: { ref: Number(match[1]) }, role: match[2], label: JSON.parse(match[3]), disabled: /\bdisabled\b/.test(line.slice(match[0].length)) }];
  });
}

export function playwrightCandidates(text) {
  return String(text ?? "").split("\n").flatMap(line => {
    const match = /^\s*- (button|textbox|status)(?:\s+("(?:[^"\\]|\\.)*"))?\s+.*?\[ref=([a-z\d]+)\]/i.exec(line);
    if (!match) return [];
    let label = "";
    if (match[2]) {
      try { label = JSON.parse(match[2]); } catch { return []; }
    }
    return [{ role: match[1] === "textbox" ? "field" : match[1], label, target: match[3], disabled: line.includes("[disabled]") }];
  });
}

export function devtoolsCandidates(text) {
  return String(text ?? "").split("\n").flatMap(line => {
    const match = /^\s*uid=([\w-]+) (button|textbox) "([^"]+)"(?:\s|$)/.exec(line);
    if (!match) return [];
    const attributes = line.slice(match[0].length).replace(/"[^"]*"/g, '""');
    return [{ target: match[1], role: match[2] === "textbox" ? "field" : match[2], label: match[3],
      disabled: /(?:^|\s)disabled(?:\s|$)/.test(attributes) }];
  });
}

function injected(calls, phase) {
  calls.push({ phase, method: "injected", tool: null, startedAt: new Date().toISOString(), ms: 0, deadlineMs: null,
    requestWireBytes: 0, responseWireBytes: 0, responseTextBytes: 0, requestTokens: 0, responseTextTokens: 0,
    imageBlocks: 0, outcome: "failed", code: `INJECTED_${phase.toUpperCase()}`, execution: null });
  throw failure(`INJECTED_${phase.toUpperCase()}`, `Injected ${phase} failure`);
}

function selectWithProbe(plan, candidates, fault) {
  const actions = chooseActions(plan, candidates);
  if (fault === "duplicate") return [...actions, ...actions];
  if (fault === "wrong") {
    const distractor = candidates.find(candidate => candidate.role === "button" && /^Preview invoice /.test(candidate.label));
    if (!distractor) throw failure("PROBE_TARGET_MISSING", "Wrong-target probe could not locate its observed distractor");
    return [{ action: "click", target: distractor.target }];
  }
  return actions;
}

export function chooseNativeActions(plan, view, fault, requireCompleteView) {
  const actions = selectWithProbe(plan, nativeCandidates(view), fault);
  if (requireCompleteView && /^… \d+ more \(/mu.test(view)) {
    throw failure("INCOMPLETE_TARGET_VIEW", "The read omitted lines. Narrow the query or expand the read before choosing a target");
  }
  return actions;
}

const parse = text => { try { return JSON.parse(text); } catch { return null; } };

function startOpenCode({ fixture, root, dir, origins, deadlineMs, meter, sessionId, engine, managed, inputMode, observationPolicy }) {
  const client = openStdio({ entry: managed ? fixture.launchers.mcp : path.join(root, "dist/adapters/mcp/server.js"),
    args: origins.flatMap(origin => ["--allowed-origin", origin]), cwd: dir, env: fixture.env, deadlineMs, meter });
  const tool = (calls, phase, name, args, options) => client.request(calls, phase, "tools/call",
    { name, arguments: { sessionId, profile: fixture.profileId, ...args } }, options);
  const run = (calls, phase, steps, extra, options) => tool(calls, phase, "browser_run", { steps, memoryMode: "off", returnMode: "all", ...extra }, options);
  const observe = (calls, phase, args) => tool(calls, phase, "browser_observe", args);
  const open = (calls, phase, args, options) => tool(calls, phase, "browser_session", args, options);
  async function readObject(calls, reply) {
    const value = parse(reply.text);
    const uri = value?.artifact?.uri;
    if (!uri || value?.result?.view || value?.observation?.view) return value;
    const prefix = `browser://sessions/${encodeURIComponent(sessionId)}/artifacts/`;
    if (!uri.startsWith(prefix) || !/^[a-f\d-]{36}$/i.test(uri.slice(prefix.length))) throw failure("ARTIFACT_SCOPE", "MCP returned an artifact outside the disposable session");
    const artifact = await client.request(calls, "artifact", "resources/read", { uri });
    return parse(artifact.text);
  }

  async function inFrame(calls, plan) {
    const listing = await run(calls, "lookup_fallback", [{ action: "capability", capability: "frames.list", input: { maxDepth: 1, maxFrames: 4 } }]);
    const listed = await readObject(calls, listing);
    const frames = listed?.results?.[0]?.result?.frames?.filter(frame => frame.depth === 1) ?? [];
    if (frames.length !== 1) throw failure("FRAME_TARGET_REQUIRED", "The observation did not identify a single child frame");
    const { frameId } = frames[0];
    const reply = await observe(calls, "lookup_fallback", { mode: "search", target: { frameId }, query: plan.entity, limit: 20, searchStrategy: "lexical" });
    const search = await readObject(calls, reply);
    return (search?.result?.results ?? []).filter(item => item.interactive && item.node_id).map(item => ({
      role: item.role ?? "button", label: item.label ?? item.name ?? item.text, target: { frameId, nodeId: item.node_id },
    }));
  }

  return {
    initialize: client.initialize,
    async setup(calls) {
      const { result } = await open(calls, "open_tab", { action: "new-tab" });
      if (engine !== "chromium") await open(calls, "viewport", { action: "configure", tabId: result.structuredContent?.activeTabId, environment: { viewport } });
    },
    async act({ goal, url, calls, fault, progress }) {
      const plan = planGoal(goal);
      const query = plan.entity.split(" ")[1];
      // Keep the injected faults on the original observation path.
      const targeted = observationPolicy === "targeted" && !fault;
      progress.phase = "navigate";
      const before = await run(calls, "navigate", [{ action: "navigate", url }], {
        postObserve: { mode: "read", ...(targeted ? { query, fullPage: true } : {}) },
      });
      progress.phase = "lookup";
      if (fault === "lookup") injected(calls, "lookup");
      const view = (await readObject(calls, before))?.observation?.view;
      let actions;
      try { actions = chooseNativeActions(plan, view, fault, targeted); progress.firstObservationMiss = false; }
      catch (error) {
        if (error.code !== "TARGET_MISSING") throw error;
        progress.firstObservationMiss = true;
        progress.phase = "lookup_fallback";
        if (plan.entity.startsWith("order ")) actions = selectWithProbe(plan, await inFrame(calls, plan), fault);
        else {
          const narrowed = await observe(calls, "lookup_fallback", { mode: "read", fullPage: true, query, detail: "full" });
          actions = chooseNativeActions(plan, (await readObject(calls, narrowed))?.result?.view, fault, targeted);
        }
      }

      progress.phase = "dispatch";
      const frameId = actions.at(-1)?.target?.frameId;
      const postObserve = { mode: "read", query: "recorded" };
      const steps = frameId && fault !== "confirmation" ? [...actions, {
        action: "capability", capability: "frames.inspect", input: { frameId, maxChars: 1600 },
      }] : actions;
      const after = await run(calls, "dispatch", steps, { inputMode,
        ...(!frameId && fault !== "confirmation" ? { postObserve } : {}) }, { mutating: true });
      progress.phase = "confirmation";
      if (fault === "confirmation") injected(calls, "confirmation");
      if (frameId) {
        const inspection = (await readObject(calls, after))?.results?.at(-1)?.result;
        return typeof inspection?.text === "string" && inspection.text.includes("Change recorded");
      }
      if (after.text.includes("Change recorded")) return true;
      const confirmation = await observe(calls, "confirmation", { ...postObserve, detail: "full" });
      return confirmation.text.includes("Change recorded");
    },
    async listTabs(calls, url, scope) {
      const { result } = await open(calls, scope === "user" ? "claim_discovery" : "claim_verification", { action: "open", scope });
      return result.structuredContent?.result?.tabs?.filter(tab => tab.url === url).map(tab => tab.id) ?? [];
    },
    async prepareClaim(calls, tabId) {
      const { result } = await open(calls, "claim_race", { action: "claim-tab", tabId }, { expectedRejection: true, allowApproval: true });
      const approval = result.structuredContent;
      if (approval?.status !== "approval_required") return null;
      if (approval.claimTarget?.id !== tabId || approval.claimTarget.profileId !== fixture.profileId || !approval.approvalToken) {
        throw failure("CLAIM_SCOPE", "The claim approval did not describe the disposable fixture tab");
      }
      return approval.approvalToken;
    },
    async confirmClaim(calls, approvalToken) {
      // The race runner explicitly authorizes this synthetic tab only.
      if (!approvalToken) return;
      await client.request(calls, "claim_race", "tools/call", {
        name: "browser_run", arguments: { sessionId, approvalToken },
      }, { expectedRejection: true, grantedApproval: true, mutating: true });
    },
    finalize: calls => tool(calls, "finalize", "browser_finalize", {}),
    close: client.close,
  };
}

function startPlaywright({ comparator, dir, env, binary, origins, deadlineMs, meter, headed, fixture }) {
  const connection = fixture?.cdpEndpoint ? ["--cdp-endpoint", fixture.cdpEndpoint] : [
    "--isolated", "--browser", "chrome", "--executable-path", binary.file, "--viewport-size", viewport.width + "x" + viewport.height,
    ...(!headed ? ["--headless"] : []),
  ];
  const client = openStdio({ entry: path.join(comparator, "cli.js"), cwd: dir, env, deadlineMs, meter,
    args: [...connection, "--allowed-origins", origins.join(";"), "--output-dir", path.join(dir, "tool-output"), "--ignore-roots", "--no-webmcp"] });
  const tool = (calls, phase, name, args = {}, options) => client.request(calls, phase, "tools/call", { name, arguments: args }, options);
  return {
    initialize: client.initialize,
    async setup(calls) {
      if (!fixture?.cdpEndpoint) return;
      const { text } = await tool(calls, "attach_discovery", "browser_tabs", { action: "list" });
      const matches = [...text.matchAll(/^- (\d+):(?: \(current\))? \[[^\r\n]*\]\(([^)\r\n]+)\)/gm)]
        .filter(match => match[2] === fixture.attachUrl);
      if (matches.length !== 1) throw failure("ATTACH_TAB_MISSING", "Playwright did not identify the exact disposable fixture tab");
      await tool(calls, "attach_select", "browser_tabs", { action: "select", index: Number(matches[0][1]) });
    },
    async act({ goal, url, calls, fault, progress }) {
      progress.phase = "navigate";
      const before = await tool(calls, "navigate", "browser_navigate", { url });
      progress.phase = "lookup";
      if (fault === "lookup") injected(calls, "lookup");
      const plan = planGoal(goal);
      let candidates = playwrightCandidates(before.text);
      let actions;
      try { actions = selectWithProbe(plan, candidates, fault); progress.firstObservationMiss = false; }
      catch (error) {
        if (error.code !== "TARGET_MISSING") throw error;
        progress.firstObservationMiss = true;
        progress.phase = "lookup_fallback";
        const snapshot = await tool(calls, "lookup_fallback", "browser_snapshot");
        candidates = playwrightCandidates(snapshot.text);
        actions = selectWithProbe(plan, candidates, fault);
      }
      const status = candidates.find(candidate => candidate.role === "status")?.target;
      let after;
      progress.phase = "dispatch";
      for (const { action, target, value } of actions) {
        after = await tool(calls, "dispatch", action === "fill" ? "browser_type" : "browser_click",
          { target, ...(action === "fill" ? { text: value } : {}) }, { mutating: true });
      }
      progress.phase = "confirmation";
      if (fault === "confirmation") injected(calls, "confirmation");
      if (after.text.includes("Change recorded")) return true;
      if (status && !plan.entity.startsWith("order ")) {
        try { return (await tool(calls, "confirmation", "browser_snapshot", { target: status })).text.includes("Change recorded"); }
        catch (error) { if (error.code !== "TOOL_ERROR") throw error; }
      }
      return (await tool(calls, "confirmation", "browser_snapshot")).text.includes("Change recorded");
    },
    finalize: calls => fixture?.cdpEndpoint ? undefined : tool(calls, "finalize", "browser_close"),
    close: client.close,
  };
}

function startDevTools({ comparator, dir, env, binary, deadlineMs, meter, headed, fixture }) {
  const connection = fixture?.cdpEndpoint ? ["--wsEndpoint", fixture.cdpEndpoint] : [
    "--isolated", "--executablePath", binary.file, "--viewport", viewport.width + "x" + viewport.height,
    "--proxyServer", "http://127.0.0.1:1", ...(!headed ? ["--headless"] : []),
  ];
  const client = openStdio({ entry: path.join(comparator, "out/Default/gen/src/bin/chrome-devtools-mcp.js"), cwd: dir, env, deadlineMs, meter,
    args: [...connection, "--no-usage-statistics", "--no-performance-crux"] });
  const tool = (calls, phase, name, args = {}, options) => client.request(calls, phase, "tools/call", { name, arguments: args }, options);
  let pageId;
  return {
    initialize: client.initialize,
    async setup(calls) {
      const attached = !!fixture?.cdpEndpoint;
      const { text } = attached ? await tool(calls, "attach_discovery", "list_pages")
        : await tool(calls, "open_tab", "new_page", { url: "about:blank" });
      const url = fixture?.attachUrl ?? "about:blank";
      const matches = [...text.matchAll(/^(\d+): ([^\r\n]+)$/gm)].filter(([, , page]) => {
        const label = page.replace(/ \[selected\]$/, "");
        return (attached || page !== label) && (label === url || label.endsWith(" (" + url + ")"));
      });
      if (matches.length !== 1) throw failure("BENCHMARK_TAB_MISSING", "DevTools did not identify the exact disposable fixture tab");
      pageId = Number(matches[0][1]);
      if (attached) await tool(calls, "attach_select", "select_page", { pageId, bringToFront: false });
    },
    async act({ goal, url, calls, fault, progress }) {
      progress.phase = "navigate";
      await tool(calls, "navigate", "navigate_page", { pageId, type: "url", url, timeout: deadlineMs });
      progress.phase = "lookup";
      if (fault === "lookup") injected(calls, "lookup");
      const plan = planGoal(goal);
      const snapshot = await tool(calls, "lookup", "take_snapshot", { pageId });
      let actions;
      try { actions = selectWithProbe(plan, devtoolsCandidates(snapshot.text), fault); progress.firstObservationMiss = false; }
      catch (error) {
        if (error.code === "TARGET_MISSING") progress.firstObservationMiss = true;
        throw error;
      }
      progress.phase = "dispatch";
      for (const { action, target, value } of actions) {
        await tool(calls, "dispatch", action, { pageId, uid: target, ...(action === "fill" ? { value } : {}) }, { mutating: true });
      }
      progress.phase = "confirmation";
      if (fault === "confirmation") injected(calls, "confirmation");
      const confirmation = await tool(calls, "confirmation", "wait_for", { pageId, text: ["Change recorded"], visible: true, timeout: Math.min(1500, deadlineMs) });
      return confirmation.text.includes("Change recorded");
    },
    finalize: calls => fixture?.cdpEndpoint || pageId === undefined ? undefined : tool(calls, "finalize", "close_page", { pageId }),
    close: client.close,
  };
}

export function startAdapter(options) {
  if (options.comparatorName === "devtools") return startDevTools(options);
  return options.comparatorName === "playwright" ? startPlaywright(options) : startOpenCode(options);
}
