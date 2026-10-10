import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { githubJson } from "../src/github-delivery/github-http";
import {
  configureGitHubAppEnvironment,
  githubAppDeployment,
  githubAppEnvironment,
  githubAppOrigin,
} from "./github-app-environment";
import {
  githubAppConfiguration,
  githubAppManifest,
  manifestCallbackCode,
} from "./github-app-manifest";

import {
  readGitHubAppConfiguration,
  saveGitHubAppConfiguration,
} from "./github-app-private-config";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Configuration = ReturnType<typeof githubAppConfiguration>;
function command(args: string[], input?: string) {
  return new Promise<void>((success, failure) => {
    // Secret material is delivered only on stdin, never argv or shell expansion.
    const child = spawn(args[0] === "run" ? "bun" : "node", args, {
      cwd: directory,
      stdio: ["pipe", "ignore", "ignore"],
      signal: AbortSignal.timeout(60000),
    });
    child.on("error", () => failure(Error("GITHUB_APP_WRANGLER_FAILED")));
    child.on("exit", (code) =>
      code === 0 ? success() : failure(Error("GITHUB_APP_WRANGLER_FAILED")),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? "",
  );
}
function html(body: string) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Paca GitHub App</title><style>body{font:16px system-ui;color:#17202a;background:#f5f7fa;margin:0;padding:48px 24px}main{max-width:640px;margin:auto;background:white;border-radius:16px;padding:32px;box-shadow:0 4px 24px #15243b12}h1{font-size:26px}p,li{line-height:1.8}button,a.button{display:inline-block;background:#2563eb;color:white;border:0;border-radius:8px;padding:12px 20px;font:inherit;text-decoration:none;cursor:pointer}small{color:#5b6470}</style><main>${body}</main></html>`;
}
async function main() {
  const environment = githubAppEnvironment(process.env.PACA_GITHUB_APP_ENVIRONMENT);
  const deployment = githubAppDeployment(environment);
  const configurationPath = resolve(directory, "../../.paca/github-app", deployment.privateFile);
  const workerConfiguration = JSON.parse(
    await readFile(resolve(directory, "wrangler.jsonc"), "utf8"),
  );
  const appOrigin = githubAppOrigin(environment, workerConfiguration.vars?.BETTER_AUTH_URL);
  const configure = async (configuration: Configuration) => {
    const report = await configureGitHubAppEnvironment(environment, configuration, (secrets) =>
      command(
        ["node_modules/wrangler/bin/wrangler.js", "secret", "bulk", "--profile", "paca"],
        JSON.stringify(secrets),
      ),
    );
    console.log(JSON.stringify(report));
  };
  await command(["run", deployment.guard]);
  if (process.argv.includes("--resume")) {
    await configure(await readGitHubAppConfiguration(configurationPath));
    return;
  }
  // Refuse a duplicate App if a prior conversion is already stored. --resume
  // can recover deployment failures without creating another key or App.
  try {
    const file = await open(configurationPath, "r");
    await file.close();
    throw Error("GITHUB_APP_EXISTS_USE_RESUME");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const nonce = randomBytes(32).toString("hex");
  let state: "waiting" | "configuring" | "configured" | "failed" = "waiting";
  let slug: string | undefined;
  let origin: string;
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'",
    );
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.method !== "GET" || request.headers.host !== new URL(origin).host) {
      response.writeHead(400).end();
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === `/setup/${nonce}` && !url.search) {
      const manifest = githubAppManifest(`${origin}/callback/${nonce}`, environment, appOrigin);
      response.end(
        html(
          `<h1>创建 Paca ${environment} 交付验收 App</h1><p>专用于 <strong>yudi-xiao/paca</strong>。请在 GitHub 上以 yudi-xiao 登录，创建后选择 <strong>Only select repositories → paca</strong>。</p><ul><li>Metadata：只读</li><li>Checks：只读</li><li>Pull requests：只读</li></ul><p>私钥将通过本机回调保存为私有配置，并写入当前项目的 Cloudflare prod Worker Secret。</p><form action="https://github.com/settings/apps/new?state=${nonce}" method="post"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button type="submit">前往 GitHub 创建 App</button></form><p><small>此页面不会请求代码写入、合并、发布或用户 OAuth 权限。</small></p>`,
        ),
      );
      return;
    }
    if (url.pathname === `/status/${nonce}`) {
      response.end(
        html(
          state === "configured" && slug
            ? `<h1>App 凭据已${deployment.stageOnly ? "安全保存" : "配置"}</h1><p>继续安装，仅选择 <strong>yudi-xiao/paca</strong> 仓库。</p><a class="button" href="https://github.com/apps/${slug}/installations/new">安装到 Paca 仓库</a>`
            : `<h1>${state === "failed" ? "配置需要恢复" : "正在保存配置"}</h1><p>${state === "failed" ? "请返回 Codex 继续恢复。私钥不会显示在此页面。" : "稍后刷新本页查看结果。"}</p>`,
        ),
      );
      return;
    }
    if (state !== "waiting") {
      response.writeHead(409).end(html("<h1>此回调已处理</h1>"));
      return;
    }
    let code: string;
    try {
      code = manifestCallbackCode(url, nonce);
    } catch {
      response.writeHead(400).end(html("<h1>回调验证失败</h1>"));
      return;
    }
    state = "configuring";
    try {
      const configuration = githubAppConfiguration(
        await githubJson(
          `/app-manifests/${code}/conversions`,
          undefined,
          AbortSignal.timeout(20000),
          fetch,
          {},
        ),
      );
      await saveGitHubAppConfiguration(configurationPath, configuration);
      slug = configuration.slug;
      response.writeHead(303, { location: `/status/${nonce}` }).end();
      await configure(configuration);
      state = "configured";
    } catch {
      state = "failed";
      console.error(
        JSON.stringify({
          status: "failed",
          code: "GITHUB_APP_SETUP_FAILED",
          recovery: `PACA_GITHUB_APP_ENVIRONMENT=${environment} bun run github:app:setup --resume`,
        }),
      );
      if (!response.headersSent)
        response
          .writeHead(503)
          .end(html("<h1>App 配置需要恢复</h1><p>请返回 Codex。不要复制私钥到聊天。</p>"));
    }
  });
  await new Promise<void>((success) => server.listen(0, "127.0.0.1", success));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("GITHUB_APP_LOCAL_SERVER_FAILED");
  origin = `http://127.0.0.1:${address.port}`;
  console.log(
    JSON.stringify({ status: "waiting", setupUrl: `${origin}/setup/${nonce}`, expiresMinutes: 55 }),
  );
  setTimeout(
    () => {
      server.close();
      server.closeAllConnections();
    },
    55 * 60 * 1000,
  ).unref();
}
main().catch(() => {
  console.error(JSON.stringify({ status: "failed", code: "GITHUB_APP_SETUP_FAILED" }));
  process.exitCode = 1;
});
