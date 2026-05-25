const pool = require('./_db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'itachiperu_secret_2024';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;
  const body = await parseBody(req);

  // ── LOGIN VENDEDOR ──
  if (action === 'login') {
    const { correo, password } = body;
    if (!correo || !password) return res.json({ error: 'Faltan datos.' });

    const { rows } = await pool.query(
      'SELECT * FROM vendedores WHERE correo = $1', [correo.toLowerCase().trim()]
    );
    const v = rows[0];
    if (!v) return res.json({ error: 'Correo o contraseña incorrectos.' });
    if (v.estado === 'suspendido') return res.json({ error: 'Cuenta suspendida. Contacta al administrador.' });

    const ok = await bcrypt.compare(password, v.password_hash);
    if (!ok) return res.json({ error: 'Correo o contraseña incorrectos.' });

    const token = jwt.sign({ id: v.id, rol: 'vendedor', slug: v.slug }, JWT_SECRET, { expiresIn: '7d' });
    await pool.query('INSERT INTO logs (vendedor_id, accion, detalle, ip) VALUES ($1,$2,$3,$4)',
      [v.id, 'login', 'Inicio de sesión', req.headers['x-forwarded-for'] || 'unknown']);

    return res.json({
      ok: true, token,
      vendedor: { id: v.id, nombre: v.nombre, correo: v.correo, slug: v.slug, foto_url: v.foto_url, color: v.color, estado: v.estado, licencia_fin: v.licencia_fin }
    });
  }

  // ── REGISTRO VENDEDOR ──
  if (action === 'registro') {
    const { nombre, correo, password, codigo_invitacion } = body;
    if (!nombre || !correo || !password) return res.json({ error: 'Faltan datos.' });

    // Verificar código de invitación si se proporcionó
    if (codigo_invitacion) {
      const { rows: cods } = await pool.query(
        'SELECT * FROM codigos_registro WHERE codigo = $1 AND usado = FALSE AND expira_at > NOW()',
        [codigo_invitacion.trim()]
      );
      if (!cods[0]) return res.json({ error: 'Código de invitación inválido o expirado.' });
    }

    const existe = await pool.query('SELECT id FROM vendedores WHERE correo = $1', [correo.toLowerCase().trim()]);
    if (existe.rows[0]) return res.json({ error: 'Este correo ya está registrado.' });

    const hash = await bcrypt.hash(password, 10);
    const slug = nombre.toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);

    const { rows } = await pool.query(
      `INSERT INTO vendedores (nombre, correo, password_hash, slug) VALUES ($1,$2,$3,$4) RETURNING *`,
      [nombre.trim(), correo.toLowerCase().trim(), hash, slug]
    );
    const v = rows[0];

    if (codigo_invitacion) {
      await pool.query('UPDATE codigos_registro SET usado=TRUE, usado_por=$1 WHERE codigo=$2', [v.id, codigo_invitacion.trim()]);
    }

    const token = jwt.sign({ id: v.id, rol: 'vendedor', slug: v.slug }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ ok: true, token, vendedor: { id: v.id, nombre: v.nombre, slug: v.slug } });
  }

  // ── LOGIN ADMIN ──
  if (action === 'admin-login') {
    const { correo, password } = body;
    const { rows } = await pool.query('SELECT * FROM admin WHERE correo = $1', [correo?.toLowerCase().trim()]);
    const a = rows[0];
    if (!a) return res.json({ error: 'Credenciales incorrectas.' });

    const ok = await bcrypt.compare(password, a.password_hash);
    if (!ok) return res.json({ error: 'Credenciales incorrectas.' });

    const token = jwt.sign({ id: a.id, rol: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ ok: true, token });
  }

  // ── VERIFICAR TOKEN ──
  if (action === 'verify') {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ', '').trim();
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.rol === 'vendedor') {
        const { rows } = await pool.query('SELECT id,nombre,correo,slug,foto_url,color,estado,licencia_fin,precio_mensual FROM vendedores WHERE id=$1', [decoded.id]);
        return res.json({ ok: true, ...decoded, vendedor: rows[0] });
      }
      return res.json({ ok: true, ...decoded });
    } catch {
      return res.status(401).json({ error: 'Token inválido.' });
    }
  }
// ── SETUP ADMIN ──
if (action === 'setup') {
  const { password } = body;
  if (!password) return res.json({ error: 'Falta contraseña.' });
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO admin (correo, password_hash) VALUES ($1,$2) ON CONFLICT (correo) DO UPDATE SET password_hash=$2',
    ['admin@itachiperu.com', hash]
  );
  return res.json({ ok: true, mensaje: 'Admin configurado.' });
}
  return res.status(405).json({ error: 'Acción no válida.' });
};
