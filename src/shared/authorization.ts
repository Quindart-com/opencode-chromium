export function authorizationQuestion(kind: "upload" | "browser-action") {
  return { required: true, state: "awaiting_user", kind, question: kind === "upload" ? "Approve the requested upload to this destination?" : "Approve the requested browser action?",
    options: ["Approve", "Disapprove"], instruction: "Use the harness's native question tool. Include the action, destination and rejection reason. Wait for the user's answer. Approval resumes the original authorization flow; disapproval stops this action. Do not switch tools or harnesses to bypass a denial." };
}
export function authorizationForError(code: string) {
  if (code === "UPLOAD_USER_DECLINED") return { required: false, state: "declined", kind: "upload", instruction: "The user declined. Preserve the prepared work and wait for a new user instruction." };
  if (["UPLOAD_CONFIRMATION_REQUIRED", "UPLOAD_NOT_AUTHORIZED"].includes(code)) return authorizationQuestion("upload");
  if (["APPROVAL_REQUIRED", "AUTHORIZATION_REQUIRED", "AUTO_REVIEW_REJECTED", "PERMISSION_DENIED"].includes(code)) return authorizationQuestion("browser-action");
  return null;
}
