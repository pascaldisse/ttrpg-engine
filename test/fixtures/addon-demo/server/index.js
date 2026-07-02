/** Test-fixture server hook: registers /demo/ping and counts journal events. */
export function register(ctx) {
  let journalEvents = 0;
  ctx.session.onChange(() => { journalEvents++; });

  ctx.registerRoute('/demo', async (req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/demo/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ pong: true, addon: ctx.addon.id, entities: ctx.session.entities.size, journalEvents }));
      return true;
    }
    return false;
  });
}
