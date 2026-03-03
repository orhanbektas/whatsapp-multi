const express = require('express');
const path = require('path');

function createGatewayServer({
  port = Number(process.env.GATEWAY_PORT || 4100),
  registrarUrl = process.env.REGISTRAR_URL || 'http://localhost:4101',
  registrarToken = process.env.REGISTRAR_INTERNAL_TOKEN || '',
  panelToken = process.env.PANEL_TOKEN || '',
} = {}) {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  function isPanelAuthorized(req) {
    if (!panelToken) return true;

    const xToken = req.header('x-panel-token');
    if (xToken && xToken === panelToken) return true;

    const auth = req.header('authorization') || '';
    const [scheme, token] = auth.split(' ');
    if (scheme && scheme.toLowerCase() === 'bearer' && token === panelToken) return true;

    return false;
  }

  app.use('/panel', (req, res, next) => {
    if (!isPanelAuthorized(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized panel token.' });
    }
    return next();
  });

  async function callRegistrar(method, endpoint, body) {
    const response = await fetch(`${registrarUrl}${endpoint}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-registrar-token': registrarToken,
      },
      body: body == null ? undefined : JSON.stringify(body),
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = { success: false, message: 'Upstream returned non-JSON response.' };
    }

    return { status: response.status, data };
  }

  app.get('/health', (_req, res) => {
    res.json({
      success: true,
      service: 'gateway',
      status: 'ok',
      registrarUrl,
    });
  });

  app.get('/panel/adb/status', async (_req, res) => {
    try {
      const upstream = await callRegistrar('GET', '/adb/status');
      return res.status(upstream.status).json(upstream.data);
    } catch (error) {
      return res.status(502).json({ success: false, message: error.message });
    }
  });

  app.get('/panel/emulator/devices', async (_req, res) => {
    try {
      const upstream = await callRegistrar('GET', '/emulator/devices');
      return res.status(upstream.status).json(upstream.data);
    } catch (error) {
      return res.status(502).json({ success: false, message: error.message });
    }
  });

  app.get('/panel/emulator/status', async (_req, res) => {
    try {
      const upstream = await callRegistrar('GET', '/emulator/status');
      return res.status(upstream.status).json(upstream.data);
    } catch (error) {
      return res.status(502).json({ success: false, message: error.message });
    }
  });

  app.post('/panel/emulator/select', async (req, res) => {
    try {
      const upstream = await callRegistrar('POST', '/emulator/select', req.body || {});
      return res.status(upstream.status).json(upstream.data);
    } catch (error) {
      return res.status(502).json({ success: false, message: error.message });
    }
  });

  app.post('/panel/emulator/start', async (req, res) => {
    try {
      const upstream = await callRegistrar('POST', '/emulator/start', req.body || {});
      return res.status(upstream.status).json(upstream.data);
    } catch (error) {
      return res.status(502).json({ success: false, message: error.message });
    }
  });

  app.post('/panel/emulator/stop', async (req, res) => {
    try {
      const upstream = await callRegistrar('POST', '/emulator/stop', req.body || {});
      return res.status(upstream.status).json(upstream.data);
    } catch (error) {
      return res.status(502).json({ success: false, message: error.message });
    }
  });

  app.post('/panel/register/start', async (req, res) => {
    try {
      const payload = {
        phone: req.body?.phone,
        deviceSerial: req.body?.deviceSerial,
        emulatorProfile: req.body?.emulatorProfile,
      };

      const upstream = await callRegistrar('POST', '/register/start', payload);
      const data = {
        success: Boolean(upstream.data?.success),
        message: upstream.data?.message || (upstream.data?.success ? 'Registration start completed.' : 'Registration start failed.'),
        phone: upstream.data?.phone || String(req.body?.phone || '').replace(/\D/g, ''),
        deviceSerial: upstream.data?.deviceSerial || req.body?.deviceSerial || null,
        state: upstream.data?.state || null,
        reason: upstream.data?.reason || null,
        traces: upstream.data?.traces || null,
      };

      return res.status(upstream.status).json(data);
    } catch (error) {
      return res.status(502).json({ success: false, message: error.message, phone: String(req.body?.phone || '').replace(/\D/g, '') });
    }
  });

  app.post('/panel/register/verify', async (req, res) => {
    try {
      const payload = {
        phone: req.body?.phone,
        otp: req.body?.otp,
        deviceSerial: req.body?.deviceSerial,
        emulatorProfile: req.body?.emulatorProfile,
      };

      const upstream = await callRegistrar('POST', '/register/verify', payload);
      const data = {
        success: Boolean(upstream.data?.success),
        message: upstream.data?.message || (upstream.data?.success ? 'Verification completed.' : 'Verification failed.'),
        phone: upstream.data?.phone || String(req.body?.phone || '').replace(/\D/g, ''),
        deviceSerial: upstream.data?.deviceSerial || req.body?.deviceSerial || null,
        state: upstream.data?.state || null,
        errorCode: upstream.data?.errorCode || null,
        reason: upstream.data?.reason || null,
        retryable: typeof upstream.data?.retryable === 'boolean' ? upstream.data.retryable : null,
        details: upstream.data?.details || null,
        uiXmlPath: upstream.data?.uiXmlPath || null,
        screenshotPath: upstream.data?.screenshotPath || null,
      };

      return res.status(upstream.status).json(data);
    } catch (error) {
      return res.status(502).json({ success: false, message: error.message, phone: String(req.body?.phone || '').replace(/\D/g, '') });
    }
  });

  function listen() {
    return app.listen(port, () => {
      console.log(`[gateway] listening on :${port}`);
    });
  }

  return { app, listen };
}

if (require.main === module) {
  const server = createGatewayServer();
  server.listen();
}

module.exports = { createGatewayServer };
