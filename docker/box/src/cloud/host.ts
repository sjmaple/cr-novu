
import { authorize } from '../shared/auth.ts';
import { messageOf } from '../shared/errors.ts';
import { HOST } from '../shared/names.ts';
import { boxes } from './boxes.ts';
import type { HostEnv } from './env.ts';
import { json, text } from './life.ts';
import { sweep } from './sweep.ts';

export { Box } from './box.ts';
export { Router } from './slack/router.ts';

export default {
  fetch(request: Request, env: HostEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__box/boxes' || url.pathname.startsWith('/__box/boxes/')) return boxes(request, env, url);
    if (url.pathname === '/__box/sweep' && request.method === 'POST') return sweepAnswer(request, env, url);

    return Promise.resolve(
      new Response(`${HOST}: reach a box through its own Worker, novu-box-<box>\n`, { status: 404 })
    );
  },
  async scheduled(_controller, env) {
    const report = await sweep(env, { dryRun: false });
    console.log(JSON.stringify(report));
  },
} satisfies ExportedHandler<HostEnv>;

async function sweepAnswer(request: Request, env: HostEnv, url: URL): Promise<Response> {
  if (!(await authorize(request))) return text("needs the same Authorization as a box's /__box/*\n", 401);
  try {
    return json(await sweep(env, { dryRun: url.searchParams.has('dry-run') }));
  } catch (error) {
    return text(`${messageOf(error)}\n`, 500);
  }
}
