import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import * as z from "zod";
import { ownerInput } from "./production-owner";

const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; script-src 'nonce-paca-local'; style-src 'nonce-paca-local'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
}

function page(email: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paca · 设置生产管理员</title>
  <style nonce="paca-local">body{font:16px/1.6 system-ui;background:#f5f6f8;color:#20242b;margin:0;padding:40px 20px}main{max-width:460px;margin:auto;background:white;padding:28px;border-radius:16px}h1{font-size:24px}label{display:block;margin:16px 0}input,button{font:inherit;box-sizing:border-box;width:100%;padding:10px;border:1px solid #cbd1db;border-radius:8px}button{background:#2455dc;color:white;cursor:pointer}button:disabled{opacity:.5}#status{white-space:pre-wrap}p{color:#526070}</style>
  <main><h1>设置 Paca 生产管理员</h1><p>此页面仅在本机开放 10 分钟。请设置正式账号密码；完成后在生产登录页登录。</p><form id="setup"><label>邮箱<input name="email" type="email" value="${escapeHtml(email)}" readonly></label><label>名称<input name="name" autocomplete="name" maxlength="80" required></label><label>密码（12～128 位）<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><label>确认密码<input name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><button>创建生产管理员</button></form><p id="status" role="status" aria-live="polite"></p></main>
  <script nonce="paca-local">const form=document.querySelector('form');const status=document.querySelector('#status');form.addEventListener('submit',async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));if(data.password!==data.confirmation){status.textContent='两次输入的密码不一致。';return}const button=form.querySelector('button');button.disabled=true;status.textContent='正在创建，请稍候…';try{const response=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});if(!response.ok)throw new Error();form.reset();form.hidden=true;status.textContent='生产管理员已创建。临时登录会话已撤销，部署完成后请在 Paca 正式入口登录。'}catch{status.textContent='创建未完成。请检查输入并重试；页面到期后请重新打开初始化页面。';button.disabled=false}});</script></html>`;
}

export async function startOwnerSetupPage(options: {
  email: string;
  createOwner: (credential: z.output<typeof ownerInput>) => Promise<void>;
  ttlMs?: number;
}): Promise<{ url: string; finished: Promise<"created" | "expired">; close: () => Promise<void> }> {
  const email = z.email().max(254).parse(options.email).toLowerCase();
  const token = randomBytes(32).toString("hex");
  const path = `/setup/${token}`;
  let state: "idle" | "pending" | "complete" = "idle";
  let expired = false;
  let pendingCreation: Promise<void> | undefined;
  let resolveFinished: (status: "created" | "expired") => void = () => undefined;
  const finished = new Promise<"created" | "expired">((resolve) => {
    resolveFinished = resolve;
  });
  let origin = "";
  const server = createServer(async (request, response) => {
    for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
    const deny = (status: number) => {
      response.writeHead(status).end();
    };
    const suppliedPath = Buffer.from(request.url ?? "");
    const expectedPath = Buffer.from(path);
    if (
      request.headers.host !== new URL(origin).host ||
      suppliedPath.length !== expectedPath.length ||
      !timingSafeEqual(suppliedPath, expectedPath) ||
      state === "complete" ||
      expired
    )
      return deny(404);
    if (request.method === "GET") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(page(email));
      return;
    }
    if (request.method !== "POST") return deny(405);
    if (request.headers.origin !== origin || request.headers["content-type"] !== "application/json")
      return deny(403);
    if (state !== "idle") return deny(409);
    state = "pending";
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 4096) throw new Error("OWNER_SETUP_INPUT_TOO_LARGE");
        chunks.push(bytes);
      }
      const input = ownerInput
        .extend({ confirmation: z.string().min(12).max(128) })
        .strict()
        .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (input.email !== email || input.password !== input.confirmation)
        throw new Error("OWNER_SETUP_INPUT_INVALID");
      if (expired) throw new Error("OWNER_SETUP_EXPIRED");
      pendingCreation = options.createOwner({
        email: input.email,
        name: input.name,
        password: input.password,
      });
      await pendingCreation;
      state = "complete";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ created: true }), () => resolveFinished("created"));
    } catch {
      state = "idle";
      deny(400);
      if (expired) {
        server.close();
        resolveFinished("expired");
      }
    } finally {
      pendingCreation = undefined;
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("OWNER_SETUP_SERVER_ADDRESS_INVALID");
  origin = `http://127.0.0.1:${address.port}`;
  const timer = setTimeout(
    () => {
      expired = true;
      // An accepted transaction gets to finish before closing its Client.
      // New submissions fail closed as soon as the page expires.
      if (state === "pending") return;
      state = "complete";
      server.closeAllConnections();
      server.close();
      resolveFinished("expired");
    },
    options.ttlMs ?? 10 * 60 * 1000,
  );
  return {
    url: `${origin}${path}`,
    finished,
    close: async () => {
      clearTimeout(timer);
      expired = true;
      await pendingCreation?.catch(() => undefined);
      state = "complete";
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      resolveFinished("expired");
    },
  };
}
