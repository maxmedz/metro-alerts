import { runCheck } from "./check.js";

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },

  async fetch(request, env) {
    const header = request.headers.get("authorization") || "";
    if (!env.CHECK_TOKEN || header !== `Bearer ${env.CHECK_TOKEN}`) {
      return new Response("not found", { status: 404 });
    }
    const force = new URL(request.url).searchParams.get("force") === "1";
    const logs = await runCheck(env, { force });
    return new Response(`${logs.join("\n")}\n`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
