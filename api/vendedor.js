const pool = require('./_db');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'itachiperu_secret_2024';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,PATCH,OPTIONS');
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

function auth(req) {
  try {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    return jwt.verify(token, JWT_SECRET);
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = auth(req);
  if (!user || user.rol !== 'vendedor') return res.status(401).json({ error: 'No autorizado.' });

  const { action } = req.query;
  const body = req.method !== 'GET' ? await parseBody(req) : {};

  // ── DASHBOARD ──
  if (action === 'dashboard') {
    const [v, principales, alias] = await Promise.all([
      pool.query('SELECT id,nombre,correo,slug,foto_url,color,estado,licencia_dias,licencia_fin,precio_mensual FROM vendedores WHERE id=$1', [user.id]),
      pool.query('SELECT COUNT(*) as total FROM correos_principales WHERE vendedor_id=$1 AND activo=TRUE', [user.id]),
      pool.query('SELECT COUNT(*) as total FROM correos_alias WHERE vendedor_id=$1 AND activo=TRUE', [user.id]),
    ]);
    const vend = v.rows[0];
    const diasRestantes = Math.max(0, Math.ceil((new Date(vend.licencia_fin) - new Date()) / 86400000));
    return res.json({
      ok: true,
      vendedor: vend,
      stats: {
        principales: parseInt(principales.rows[0].total),
        alias: parseInt(alias.rows[0].total),
        dias_restantes: diasRestantes,
        licencia_activa: diasRestantes > 0,
      }
    });
  }

  // ── CORREOS PRINCIPALES ──
  if (action === 'principales-list') {
    const { rows } = await pool.query(
      'SELECT id,correo,servicio,activo,creado_at FROM correos_principales WHERE vendedor_id=$1 ORDER BY creado_at DESC',
      [user.id]
    );
    return res.json({ ok: true, data: rows });
  }

  if (action === 'principales-add') {
    const { correo, password_app, servicio } = body;
    if (!correo || !password_app || !servicio) return res.json({ error: 'Faltan datos.' });
    const { rows } = await pool.query(
      'INSERT INTO correos_principales (vendedor_id,correo,password_app,servicio) VALUES ($1,$2,$3,$4) RETURNING id,correo,servicio',
      [user.id, correo.toLowerCase().trim(), password_app.trim(), servicio.toLowerCase()]
    );
    await pool.query('INSERT INTO logs (vendedor_id,accion,detalle) VALUES ($1,$2,$3)', [user.id, 'add_principal', correo]);
    return res.json({ ok: true, data: rows[0] });
  }

  if (action === 'principales-delete') {
    const { id } = body;
    await pool.query('DELETE FROM correos_principales WHERE id=$1 AND vendedor_id=$2', [id, user.id]);
    return res.json({ ok: true });
  }

  // ── CORREOS ALIAS ──
  if (action === 'alias-list') {
    const { rows } = await pool.query(
      `SELECT ca.id, ca.alias, ca.servicio, ca.activo, ca.creado_at, cp.correo as principal
       FROM correos_alias ca
       JOIN correos_principales cp ON cp.id = ca.correo_principal_id
       WHERE ca.vendedor_id=$1 ORDER BY ca.creado_at DESC`,
      [user.id]
    );
    return res.json({ ok: true, data: rows });
  }

  if (action === 'alias-add') {
    const { aliases, correo_principal_id, servicio } = body;
    if (!aliases || !correo_principal_id || !servicio) return res.json({ error: 'Faltan datos.' });
    const lista = Array.isArray(aliases) ? aliases : [aliases];
    const insertados = [];
    for (const alias of lista) {
      const a = alias.toLowerCase().trim();
      if (!a) continue;
      try {
        const { rows } = await pool.query(
          'INSERT INTO correos_alias (vendedor_id,correo_principal_id,alias,servicio) VALUES ($1,$2,$3,$4) RETURNING id,alias,servicio',
          [user.id, correo_principal_id, a, servicio.toLowerCase()]
        );
        insertados.push(rows[0]);
      } catch {}
    }
    await pool.query('INSERT INTO logs (vendedor_id,accion,detalle) VALUES ($1,$2,$3)', [user.id, 'add_alias', lista.join(', ')]);
    return res.json({ ok: true, data: insertados });
  }

  if (action === 'alias-delete') {
    const { id } = body;
    await pool.query('DELETE FROM correos_alias WHERE id=$1 AND vendedor_id=$2', [id, user.id]);
    return res.json({ ok: true });
  }

  // ── PERFIL ──
  if (action === 'perfil-update') {
    const { nombre, foto_url, color } = body;
    const { rows } = await pool.query(
      'UPDATE vendedores SET nombre=COALESCE($1,nombre), foto_url=COALESCE($2,foto_url), color=COALESCE($3,color) WHERE id=$4 RETURNING nombre,foto_url,color',
      [nombre, foto_url, color, user.id]
    );
    return res.json({ ok: true, data: rows[0] });
  }

  return res.status(404).json({ error: 'Acción no encontrada.' });
};
