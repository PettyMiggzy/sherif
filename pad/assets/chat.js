/*
 * Robin Labs AI — the floating chat widget.
 *
 * One script tag on any page. It works out its own scope: a page with a coin in the URL
 * (?c=0x… or ?token=0x…) asks about THAT coin, everything else asks about the pad. Nothing here
 * knows which model answers, or who provides it — the browser sends words and receives words.
 *
 * It stays hidden unless /api/chat/enabled says the server can actually answer, because a chat
 * button that always apologises is worse than no chat button.
 */
import { API_BASE } from "./config.js";

const MAX_TURNS = 12; // matches the server; trimming here keeps requests small too
const KEY = "rl:chat:v1";

const el = (tag, css, html) => {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/// The reply is plain text from a model. It is inserted as TEXT, never as HTML — a model that can
/// be talked into emitting a <script> tag must not be able to run it in our page, and "the model
/// would never do that" is not a security boundary.
function renderText(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

function coinFromUrl() {
  const q = new URLSearchParams(location.search);
  for (const k of ["c", "token", "coin"]) {
    const v = (q.get(k) || "").trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) return v.toLowerCase();
  }
  return null;
}

export async function mountChat() {
  if (!API_BASE || document.getElementById("rlChatBtn")) return;
  let cfg;
  try {
    const r = await fetch(API_BASE.replace(/\/+$/, "") + "/api/chat/enabled", { signal: AbortSignal.timeout(6000) });
    cfg = await r.json();
  } catch { return; }
  if (!cfg || !cfg.enabled) return;

  const token = coinFromUrl();
  const scope = token ? "coin" : "pad";

  const css = `
  #rlChatBtn{position:fixed;right:16px;bottom:16px;z-index:9998;border:none;border-radius:999px;
    background:#dce905;color:#0a0e05;font:800 .85rem/1 "Plus Jakarta Sans",system-ui,sans-serif;
    padding:13px 18px;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.45)}
  #rlChatBtn:hover{filter:brightness(1.06)}
  #rlChat{position:fixed;right:16px;bottom:16px;z-index:9999;width:min(380px,calc(100vw - 32px));
    height:min(560px,calc(100vh - 32px));display:none;flex-direction:column;background:#0c1108;
    border:1px solid rgba(220,233,5,.28);border-radius:16px;overflow:hidden;
    box-shadow:0 18px 60px rgba(0,0,0,.6);font-family:"Plus Jakarta Sans",system-ui,sans-serif}
  #rlChat.open{display:flex}
  #rlChatHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;
    border-bottom:1px solid rgba(220,233,5,.16);color:#f4f7ee}
  #rlChatHead b{font-size:.92rem;letter-spacing:-.01em}
  #rlChatHead span{font-size:.7rem;color:#93a382;display:block;font-weight:600}
  #rlChatX{background:none;border:none;color:#93a382;font-size:1.3rem;cursor:pointer;line-height:1;padding:0 4px}
  #rlChatLog{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
  .rlMsg{max-width:86%;padding:9px 12px;border-radius:12px;font-size:.85rem;line-height:1.5;white-space:normal}
  .rlMsg.me{align-self:flex-end;background:rgba(220,233,5,.13);color:#f4f7ee;border:1px solid rgba(220,233,5,.28)}
  .rlMsg.ai{align-self:flex-start;background:#070a04;color:#e7ecdd;border:1px solid rgba(255,255,255,.07)}
  .rlMsg.err{align-self:flex-start;background:rgba(255,90,82,.1);color:#ffb9b4;border:1px solid rgba(255,90,82,.35)}
  #rlChatFoot{padding:10px;border-top:1px solid rgba(220,233,5,.16);display:flex;gap:8px}
  #rlChatIn{flex:1;background:#070a04;border:1px solid rgba(220,233,5,.16);border-radius:10px;
    color:#f4f7ee;padding:10px 12px;font:inherit;font-size:.85rem}
  #rlChatIn:focus{outline:2px solid rgba(220,233,5,.4);outline-offset:1px}
  #rlChatSend{background:#dce905;color:#0a0e05;border:none;border-radius:10px;padding:0 14px;
    font-weight:800;cursor:pointer;font-size:.82rem}
  #rlChatSend:disabled{opacity:.45;cursor:not-allowed}
  .rlNote{font-size:.68rem;color:#6f7d5a;padding:0 14px 10px;text-align:center}
  @media(prefers-reduced-motion:no-preference){#rlChat{animation:rlIn .16s ease-out}}
  @keyframes rlIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`;
  document.head.appendChild(el("style", null, css));

  const btn = el("button", null, "Ask Robin Labs AI");
  btn.id = "rlChatBtn";
  btn.type = "button";
  const panel = el("div");
  panel.id = "rlChat";
  panel.innerHTML = `
    <div id="rlChatHead">
      <div><b>Robin Labs AI</b><span>${token ? "asking about this coin" : "how the pad works"}</span></div>
      <button id="rlChatX" type="button" aria-label="Close">&times;</button>
    </div>
    <div id="rlChatLog" role="log" aria-live="polite"></div>
    <div class="rlNote">Cannot give financial advice. Answers can be wrong — check the docs.</div>
    <div id="rlChatFoot">
      <input id="rlChatIn" type="text" maxlength="500" placeholder="${token ? "Ask about this coin…" : "How do I launch a coin?"}" />
      <button id="rlChatSend" type="button">Send</button>
    </div>`;
  document.body.append(btn, panel);

  const log = panel.querySelector("#rlChatLog");
  const input = panel.querySelector("#rlChatIn");
  const send = panel.querySelector("#rlChatSend");

  // History is per page-scope and per coin, so switching coins does not carry the last coin's
  // conversation — the model would otherwise answer about the wrong token with total confidence.
  const storeKey = `${KEY}:${scope}:${token || "pad"}`;
  let history = [];
  try { history = JSON.parse(sessionStorage.getItem(storeKey) || "[]"); } catch { history = []; }

  function draw() {
    log.innerHTML = history.map((m) =>
      `<div class="rlMsg ${m.role === "user" ? "me" : (m.error ? "err" : "ai")}">${renderText(m.content)}</div>`).join("");
    log.scrollTop = log.scrollHeight;
  }
  function save() {
    try { sessionStorage.setItem(storeKey, JSON.stringify(history.slice(-MAX_TURNS * 2))); } catch { /* private window */ }
  }
  function push(role, content, error) { history.push({ role, content, error }); draw(); save(); }

  if (!history.length) {
    push("assistant", token
      ? "Hi — I'm Robin Labs AI. Ask me anything about this coin or how the pad works. I can't tell you whether to buy it."
      : "Hi — I'm Robin Labs AI. Ask me how launching, fees, bonding or staking work here.");
  } else draw();

  let busy = false;
  async function ask() {
    const text = (input.value || "").trim();
    if (!text || busy) return;
    input.value = "";
    push("user", text);
    busy = true; send.disabled = true;
    const thinking = { role: "assistant", content: "…" };
    history.push(thinking); draw();

    try {
      const body = { scope, messages: history.filter((m) => m !== thinking && !m.error).slice(-MAX_TURNS) };
      if (token) body.token = token;
      const r = await fetch(API_BASE.replace(/\/+$/, "") + "/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
      });
      const j = await r.json().catch(() => ({}));
      history.splice(history.indexOf(thinking), 1);
      if (!r.ok) {
        // retryAfter comes from the provider via our API — a real countdown beats "try later".
        push("assistant", j.retryAfter
          ? `${j.error || "Busy right now"} (about ${Math.ceil(j.retryAfter)}s)`
          : (j.error || "I couldn't answer that — try again."), true);
      } else {
        push("assistant", j.reply || "I couldn't answer that — try again.", !j.reply);
      }
    } catch {
      const i = history.indexOf(thinking);
      if (i >= 0) history.splice(i, 1);
      push("assistant", "I couldn't reach the server — try again in a moment.", true);
    } finally { busy = false; send.disabled = false; input.focus(); }
  }

  btn.addEventListener("click", () => {
    panel.classList.add("open"); btn.style.display = "none"; input.focus(); draw();
  });
  panel.querySelector("#rlChatX").addEventListener("click", () => {
    panel.classList.remove("open"); btn.style.display = "";
  });
  send.addEventListener("click", ask);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ask(); } });
}

if (typeof window !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => mountChat());
  else mountChat();
}
