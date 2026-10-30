import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER_SOURCE,refreshBrowserMarketplace,type CodexCommand } from "../../src/management/marketplace.ts";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-repair-")), home = path.join(root, "codex"), dir = path.join(root, "runtime");
  fs.mkdirSync(home); fs.mkdirSync(dir); let config = '[plugins."opencode-browser-plugin@quindart-browser"]\nenabled=true\n';
  fs.writeFileSync(path.join(home, "config.toml"), config);
  const calls: string[][] = []; let version = "1.10.1", conflict = false;
  const run: CodexCommand = async (_home, args) => {
    calls.push(args); await new Promise(resolve => setTimeout(resolve, 5));
    if (args[2] === "add") {
      if (conflict) { conflict = false; throw new Error("existing snapshot"); }
      config = fs.readFileSync(path.join(home, "config.toml"), "utf8") + `\n[marketplaces.quindart-browser]\nsource_type="git"\nsource="${BROWSER_SOURCE}"\nref="master"\n`;
      fs.writeFileSync(path.join(home, "config.toml"), config);
    }
    if (args[1] === "add") {
      const installedPath = path.join(home, "plugins/cache/quindart-browser/opencode-browser-plugin", version);
      fs.mkdirSync(path.join(installedPath, ".codex-plugin"), { recursive: true });
      fs.writeFileSync(path.join(installedPath, ".codex-plugin/plugin.json"), JSON.stringify({ name: "opencode-browser-plugin", version }));
      const config = JSON.parse(fs.readFileSync(new URL("../../.mcp.json", import.meta.url), "utf8"));
      fs.writeFileSync(path.join(installedPath, ".mcp.json"), JSON.stringify(config));
      return { version, installedPath };
    }
    return {};
  };
  return { root,home,dir,calls,run,setVersion: (value: string) => { version=value; }, conflict: () => { conflict=true; } };
}
function cleanup(root: string) { expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir())); expect(path.basename(root)).toStartWith("catalog-repair-"); fs.rmSync(root,{recursive:true,force:true}); }

test("enabled old plugin with a missing Git source repairs the catalog and verifies the installed managed package", async () => {
  const f=fixture(); f.conflict();
  try {
    const result=await refreshBrowserMarketplace({...f,version:"1.10.1"});
    expect(result).toMatchObject({status:"refreshed",installedVersion:"1.10.1"});
    expect(fs.readFileSync(path.join(f.home,"config.toml"),"utf8")).not.toContain("mcp_servers");
    expect(f.calls.map(a=>a.slice(1,3).join(" "))).toEqual(["marketplace add","marketplace remove","marketplace add","marketplace upgrade","add opencode-browser-plugin@quindart-browser"]);
    expect(fs.readFileSync(path.join(f.home,"config.toml"),"utf8")).toContain('enabled=true');
    expect((await refreshBrowserMarketplace({...f,version:"1.10.1"})).status).toBe("current");
  } finally {cleanup(f.root);}
});
test("command success without an installed package never marks the catalog current; failure retries after backoff", async()=>{
  const f=fixture(); let now=1000000;
  try {
    const options={...f,version:"1.10.1",now:()=>now};
    expect((await refreshBrowserMarketplace({...options,run:async()=>({})})).status).toBe("retry");
    expect((await refreshBrowserMarketplace(options)).status).toBe("retry");
    expect(f.calls).toHaveLength(0); now+=300001;
    expect((await refreshBrowserMarketplace(options)).status).toBe("refreshed");
  }finally{cleanup(f.root);}
});
test("same-version catalogs refresh on schedule, repair lost configuration immediately, and coalesce multiple hosts",async()=>{
  const f=fixture();let now=1000000;
  try{
    const options={...f,version:"1.10.1",now:()=>now};
    const results=await Promise.all([refreshBrowserMarketplace(options),refreshBrowserMarketplace(options)]);
    expect(results.map(r=>r.status).sort()).toEqual(["pending","refreshed"]);
    f.setVersion("1.10.2");now+=6*60*60*1000+1;
    expect(await refreshBrowserMarketplace(options)).toMatchObject({status:"refreshed",installedVersion:"1.10.2"});
    fs.writeFileSync(path.join(f.home,"config.toml"),'[plugins."opencode-browser-plugin@quindart-browser"]\nenabled=true\n');
    expect((await refreshBrowserMarketplace(options)).status).toBe("refreshed");
  }finally{cleanup(f.root);}
});
test("deliberate local or pinned catalogs and disabled plugins are preserved",async()=>{
  const f=fixture();
  try{
    for(const [source,status] of [['source_type="local"\nsource="local-checkout"','custom_source'],[`source_type="git"\nsource="${BROWSER_SOURCE}"\nref="v1.10.1"`,'pinned']]){
      const config='[plugins."opencode-browser-plugin@quindart-browser"]\nenabled=true\n[marketplaces.quindart-browser]\n'+source;
      fs.writeFileSync(path.join(f.home,"config.toml"),config);
      expect((await refreshBrowserMarketplace({...f,version:"1.10.1"})).status).toBe(status);
      expect(fs.readFileSync(path.join(f.home,"config.toml"),"utf8")).toBe(config);
    }
    expect(f.calls).toHaveLength(0);
  }finally{cleanup(f.root);}
});
