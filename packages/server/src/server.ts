import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

import fastifyStatic from '@fastify/static';
import type { OverlayLayer, Preset, Project } from '@yulyrics/core';
import { BUNDLED_FONTS, buildFontFaceCss } from '@yulyrics/presets';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';

import type { AppConfig } from './config.js';
import { loadConfig, updateConfig } from './config.js';
import { getDesktopStatus } from './desktop.js';
import { Hub } from './hub.js';
import { bundledFontsDir, controlDist, ensureDir, overlayDist } from './paths.js';
import {
  deletePreset,
  deleteProject,
  getPreset,
  getProject,
  listPresets,
  listProjects,
  savePreset,
  saveProject,
} from './store.js';

export interface ServerHandle {
  app: FastifyInstance;
  hub: Hub;
  /** 실제로 열린 포트. 기본 포트가 사용 중이면 다른 번호가 된다. */
  port: number;
  urls: { control: string; overlay: string; lan: string | null };
  close: () => Promise<void>;
}

/**
 * 로컬 서버를 띄운다.
 *
 * CLI(`npm start`)와 Electron 셸이 **같은 함수**를 쓴다.
 * 데스크톱 앱이라고 서버가 달라지면 "브라우저에서는 되는데 앱에서는 안 되는" 부류의
 * 문제가 생긴다. 진입점만 다르고 서버는 하나여야 한다.
 */
export async function startServer(): Promise<ServerHandle> {
  const hub = new Hub();
  const app = Fastify({ logger: false });

  // -------------------------------------------------------------------------
  // 정적 파일
  // -------------------------------------------------------------------------

  /**
   * 프런트엔드 파일은 항상 재검증시킨다.
   *
   * 오버레이 번들은 파일명이 `overlay.js` 로 고정이라 해시가 붙지 않는다.
   * OBS 브라우저 소스(CEF)는 캐시를 아주 오래 붙들고 있어서,
   * 그냥 두면 프로그램을 업데이트해도 **OBS만 예전 코드를 계속 돌린다.**
   * 실제로 이것 때문에 새 기능이 OBS에서만 동작하지 않는 일이 있었다.
   * 로컬 서버이므로 매번 재검증(304)해도 비용이 사실상 없다.
   */
  const noCache = (res: { setHeader: (k: string, v: string) => void }): void => {
    res.setHeader('cache-control', 'no-cache');
  };

  if (existsSync(controlDist())) {
    await app.register(fastifyStatic, {
      root: controlDist(),
      prefix: '/',
      cacheControl: false,
      setHeaders: noCache,
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html; charset=utf-8').send(notBuiltPage('컨트롤 패널', 'control')),
    );
  }

  // 폰트는 오버레이·컨트롤·에디터가 모두 같은 경로에서 받는다
  await app.register(fastifyStatic, {
    root: ensureDir(bundledFontsDir()),
    prefix: '/fonts/',
    decorateReply: false,
    maxAge: 31_536_000_000, // 폰트 파일은 내용이 바뀌지 않는다
  });

  app.get('/fonts/fonts.css', async (_req, reply) =>
    reply
      .type('text/css; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(buildFontFaceCss('/fonts/')),
  );

  app.get('/api/fonts', async () => BUNDLED_FONTS);

  if (existsSync(overlayDist())) {
    await app.register(fastifyStatic, {
      root: overlayDist(),
      prefix: '/overlay/',
      decorateReply: !existsSync(controlDist()),
      cacheControl: false,
      setHeaders: noCache,
    });
    // 슬래시 없는 /overlay 도 동작해야 한다 — OBS 에 넣는 URL 이 짧을수록 좋다
    app.get('/overlay', async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .sendFile('index.html', overlayDist()),
    );
  } else {
    app.get('/overlay', async (_req, reply) =>
      reply.type('text/html; charset=utf-8').send(notBuiltPage('오버레이', 'overlay')),
    );
  }

  // -------------------------------------------------------------------------
  // REST API
  // -------------------------------------------------------------------------

  app.get('/api/status', async () => {
    const config = loadConfig();
    const { overlays, controls, obsOverlays } = hub.peerCounts;
    return {
      port: actualPort,
      lan: config.lan,
      token: config.token,
      globalOffsetMs: config.globalOffsetMs,
      hotkeys: config.hotkeys,
      minimizeToTray: config.minimizeToTray,
      desktop: getDesktopStatus(),
      overlays,
      obsOverlays,
      controls,
      connectedOverlays: hub.connectedOverlays,
      urls: overlayUrls(),
    };
  });

  app.post<{ Body: Partial<AppConfig> }>('/api/config', async (req) => updateConfig(req.body ?? {}));

  app.get('/api/presets', async () => listPresets());

  app.get<{ Params: { id: string } }>('/api/presets/:id', async (req, reply) => {
    const preset = getPreset(req.params.id);
    if (!preset) return reply.code(404).send({ error: '프리셋을 찾을 수 없습니다' });
    return preset;
  });

  app.put<{ Params: { id: string }; Body: Preset }>('/api/presets/:id', async (req) => {
    const saved = savePreset({ ...req.body, id: req.params.id });
    hub.refreshPresetIfActive(saved.id);
    return saved;
  });

  app.delete<{ Params: { id: string } }>('/api/presets/:id', async (req, reply) => {
    if (!deletePreset(req.params.id)) {
      return reply.code(404).send({ error: '사용자 프리셋이 아니거나 없습니다' });
    }
    hub.refreshPresetIfActive(req.params.id);
    return { ok: true };
  });

  app.get('/api/projects', async () => listProjects());

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: '곡을 찾을 수 없습니다' });
    return project;
  });

  app.put<{ Params: { id: string }; Body: Project }>('/api/projects/:id', async (req) =>
    saveProject({ ...req.body, id: req.params.id }),
  );

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    if (!deleteProject(req.params.id)) return reply.code(404).send({ error: '없는 곡입니다' });
    return { ok: true };
  });

  app.get('/api/state', async () => hub.snapshot);

  app.post<{ Body: { playing: boolean; mediaTimeMs: number; rate?: number } }>(
    '/api/state/transport',
    async (req) => {
      hub.setTransport(req.body.playing, req.body.mediaTimeMs, req.body.rate ?? 1);
      return { ok: true };
    },
  );

  app.post<{ Body: { presetId: string } }>('/api/state/preset', async (req, reply) => {
    if (!hub.setPresetById(req.body.presetId)) {
      return reply.code(404).send({ error: '프리셋을 찾을 수 없습니다' });
    }
    return { ok: true };
  });

  app.post<{ Body: { project: Project | null } }>('/api/state/project', async (req) => {
    hub.setProject(req.body.project);
    return { ok: true };
  });

  app.post<{ Body: { mode: 'manual' | 'timeline' } }>('/api/state/mode', async (req) => {
    hub.setMode(req.body.mode);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // 수동(PPT) 모드 커서
  //
  // GET 도 함께 받는다. 스트림덱·AutoHotkey 같은 도구는 대개 URL 하나만
  // 호출할 수 있어서, POST 만 열어두면 붙일 방법이 없다.
  // Electron 전역 단축키도 이 경로를 그대로 쓴다 — 조작 경로가 하나뿐이어야
  // "단축키로는 되는데 버튼으로는 안 된다" 같은 일이 안 생긴다.
  // -------------------------------------------------------------------------

  const bothMethods = ['GET', 'POST'] as const;

  app.route({
    method: [...bothMethods],
    url: '/api/cursor/next',
    handler: async () => ({ cursor: hub.setCursor(hub.cursor + 1) }),
  });

  app.route({
    method: [...bothMethods],
    url: '/api/cursor/prev',
    handler: async () => ({ cursor: hub.setCursor(hub.cursor - 1) }),
  });

  app.route({
    method: [...bothMethods],
    url: '/api/cursor/reset',
    handler: async () => ({ cursor: hub.setCursor(-1) }),
  });

  app.route({
    method: [...bothMethods],
    url: '/api/state/hidden/toggle',
    handler: async () => ({ hidden: hub.toggleHidden() }),
  });

  app.post<{ Body: { index: number } }>('/api/cursor', async (req) => ({
    cursor: hub.setCursor(req.body.index),
  }));

  app.post('/api/demo/start', async () => {
    hub.startDemo();
    return { ok: true };
  });

  app.post('/api/demo/stop', async () => {
    hub.stopDemo();
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    if (!isAuthorized(url.searchParams.get('token'), req.socket.remoteAddress)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    /*
     * OBS 브라우저 소스는 User-Agent 에 `OBS/<버전>` 을 붙인다.
     *
     * 페이지 안의 `window.obsstudio` 로도 알 수 있지만, 그건 **오버레이 번들이 최신일 때만**
     * 통한다. OBS 는 캐시를 오래 붙들기 때문에, 옛 번들을 돌고 있는 OBS 가 영원히
     * "브라우저"로 잡히는 일이 실제로 있었다. 서버가 직접 보면 그 문제가 없다.
     */
    const userAgent = req.headers['user-agent'] ?? '';
    const inObsByUserAgent = /\bOBS\b/i.test(userAgent);

    wss.handleUpgrade(req, socket, head, (ws) => {
      const presetId = url.searchParams.get('preset');
      const layer = (url.searchParams.get('layer') ?? 'lyrics') as OverlayLayer;
      hub.addClient(ws, presetId, layer, inObsByUserAgent, userAgent);
    });
  });

  // -------------------------------------------------------------------------
  // 시작
  // -------------------------------------------------------------------------

  /** 로컬호스트는 토큰 없이 통과. LAN 모드일 때만 외부 접속에 토큰을 요구한다. */
  function isAuthorized(token: string | null, remoteAddress: string | undefined): boolean {
    const config = loadConfig();
    if (!config.lan) return true;
    if (isLocal(remoteAddress)) return true;
    return token === config.token;
  }

  function overlayUrls(): ServerHandle['urls'] {
    const config = loadConfig();
    const ip = lanAddress();
    return {
      control: `http://127.0.0.1:${actualPort}/`,
      overlay: `http://127.0.0.1:${actualPort}/overlay`,
      lan: config.lan && ip ? `http://${ip}:${actualPort}/overlay?token=${config.token}` : null,
    };
  }

  /** 포트가 사용 중이면 다음 번호를 시도한다. 실제 포트는 UI 가 안내한다. */
  async function listenWithFallback(start: number, host: string, attempts = 12): Promise<number> {
    for (let i = 0; i < attempts; i++) {
      const port = start + i;
      try {
        await app.listen({ port, host });
        return port;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
        console.warn(`[yulyrics] 포트 ${port} 사용 중 — 다음 포트를 시도합니다`);
      }
    }
    throw new Error(`사용 가능한 포트를 찾지 못했습니다 (${start}~${start + attempts - 1})`);
  }

  const config = loadConfig();
  const actualPort = await listenWithFallback(
    config.port,
    config.lan ? '0.0.0.0' : '127.0.0.1',
  );

  return {
    app,
    hub,
    port: actualPort,
    urls: overlayUrls(),
    close: async () => {
      hub.dispose();
      await app.close();
    },
  };
}

function isLocal(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

function notBuiltPage(label: string, workspace: string): string {
  return `<!doctype html><meta charset="utf-8">
<title>yulyrics — 빌드 필요</title>
<body style="font-family:system-ui;background:#14161a;color:#e6e8eb;padding:48px;line-height:1.7">
<h1 style="margin:0 0 8px">${label}이(가) 아직 빌드되지 않았습니다</h1>
<p>다음 명령으로 빌드한 뒤 새로고침하세요.</p>
<pre style="background:#000;padding:16px;border-radius:8px">npm run build --workspace=@yulyrics/${workspace}</pre>
</body>`;
}
