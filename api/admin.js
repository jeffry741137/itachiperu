const pool = require('./_db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
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
function authAdmin(req) {
  try {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    const d = jwt.verify(token, JWT_SECRET);
    return d.rol === 'admin' ? d : null;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = authAdmin(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { action } = req.query;
  const body = req.method !== 'GET' ? await parseBody(req) : {};

  // ── DASHBOARD STATS ──
  if (action === 'stats') {
    const [vends, princi, alias, trans, activos] = await Promise.all([
      pool.query('SELECT COUNT(*) as t FROM vendedores'),
      pool.query('SELECT COUNT(*) as t FROM correos_principales'),
      pool.query('SELECT COUNT(*) as t FROM correos_alias'),
      pool.query('SELECT COALESCE(SUM(monto),0) as t FROM transacciones WHERE DATE_TRUNC(\'month\',creado_at)=DATE_TRUNC(\'month\',NOW())'),
      pool.query('SELECT COUNT(*) as t FROM vendedores WHERE estado=\'activo\' AND licencia_fin > NOW()'),
    ]);
    return res.json({
      ok: true,
      stats: {
        vendedores: parseInt(vends.rows[0].t),
        principales: parseInt(princi.rows[0].t),
        alias: parseInt(alias.rows[0].t),
        ingresos_mes: parseFloat(trans.rows[0].t),
        licencias_activas: parseInt(activos.rows[0].t),
      }
    });
  }

  // ── VENDEDORES ──
  if (action === 'vendedores-list') {
    const { rows } = await pool.query(
      `SELECT v.id, v.nombre, v.correo, v.slug, v.estado, v.licencia_fin, v.precio_mensual, v.creado_at,
       (SELECT COUNT(*) FROM correos_principales WHERE vendedor_id=v.id) as principales,
       (SELECT COUNT(*) FROM correos_alias WHERE vendedor_id=v.id) as alias
       FROM vendedores v ORDER BY v.creado_at DESC`
    );
    return res.json({ ok: true, data: rows });
  }

  if (action === 'vendedor-add') {
    const { nombre, correo, password, licencia_dias, precio_mensual } = body;
    if (!nombre || !correo || !password) return res.json({ error: 'Faltan datos.' });
    const hash = await bcrypt.hash(password, 10);
    const slug = nombre.toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
    const dias = licencia_dias || 30;
    const { rows } = await pool.query(
      `INSERT INTO vendedores (nombre,correo,password_hash,slug,licencia_dias,licencia_fin,precio_mensual)
       VALUES ($1,$2,$3,$4,$5,NOW()+($5||' days')::INTERVAL,$6) RETURNING id,nombre,correo,slug`,
      [nombre.trim(), correo.toLowerCase().trim(), hash, slug, dias, precio_mensual || 29.90]
    );
    await pool.query('INSERT INTO logs (accion,detalle) VALUES ($1,$2)', ['admin_add_vendedor', correo]);
    return res.json({ ok: true, data: rows[0] });
  }

  if (action === 'vendedor-update') {
    const { id, estado, licencia_dias, precio_mensual } = body;
    await pool.query(
      `UPDATE vendedores SET 
        estado=COALESCE($1,estado),
        licencia_fin=CASE WHEN $2::int IS NOT NULL THEN NOW()+($2||' days')::INTERVAL ELSE licencia_fin END,
        precio_mensual=COALESCE($3,precio_mensual)
       WHERE id=$4`,
      [estado, licencia_dias, precio_mensual, id]
    );
    return res.json({ ok: true });
  }

  if (action === 'vendedor-delete') {
    const { id } = body;
    await pool.query('DELETE FROM vendedores WHERE id=$1', [id]);
    return res.json({ ok: true });
  }

  // ── CÓDIGOS DE REGISTRO ──
  if (action === 'codigo-generar') {
    const codigo = Math.floor(1000 + Math.random() * 9000).toString();
    const { rows } = await pool.query(
      'INSERT INTO codigos_registro (codigo) VALUES ($1) RETURNING codigo, expira_at',
      [codigo]
    );
    return res.json({ ok: true, data: rows[0] });
  }

  if (action === 'codigos-list') {
    const { rows } = await pool.query(
      `SELECT cr.*, v.nombre as usado_por_nombre 
       FROM codigos_registro cr 
       LEFT JOIN vendedores v ON v.id=cr.usado_por 
       ORDER BY cr.creado_at DESC LIMIT 20`
    );
    return res.json({ ok: true, data: rows });
  }

  // ── TODOS LOS CORREOS PRINCIPALES ──
  if (action === 'principales-list') {
    const { vendedor_id } = req.query;
    const q = vendedor_id
      ? 'SELECT cp.*, v.nombre as vendedor_nombre FROM correos_principales cp JOIN vendedores v ON v.id=cp.vendedor_id WHERE cp.vendedor_id=$1 ORDER BY cp.creado_at DESC'
      : 'SELECT cp.*, v.nombre as vendedor_nombre FROM correos_principales cp JOIN vendedores v ON v.id=cp.vendedor_id ORDER BY cp.creado_at DESC';
    const params = vendedor_id ? [vendedor_id] : [];
    const { rows } = await pool.query(q, params);
    // password_app visible solo para admin (ya estamos en endpoint admin autenticado)
    return res.json({ ok: true, data: rows });
  }

  // ── ELIMINAR CORREOS PRINCIPALES DE VENDEDOR ──
  if (action === 'principal-delete') {
    const { id } = body;
    await pool.query('DELETE FROM correos_principales WHERE id=$1', [id]);
    await pool.query('INSERT INTO logs (accion,detalle) VALUES ($1,$2)', ['admin_delete_principal', `ID: ${id}`]);
    return res.json({ ok: true });
  }

  // ── ELIMINAR ALIAS DE VENDEDOR ──
  if (action === 'alias-delete') {
    const { id } = body;
    await pool.query('DELETE FROM correos_alias WHERE id=$1', [id]);
    await pool.query('INSERT INTO logs (accion,detalle) VALUES ($1,$2)', ['admin_delete_alias', `ID: ${id}`]);
    return res.json({ ok: true });
  }

  // ── LISTAR ALIAS DE UN VENDEDOR ──
  if (action === 'alias-list') {
    const { vendedor_id } = req.query;
    const q = vendedor_id
      ? 'SELECT ca.*, cp.correo as principal FROM correos_alias ca JOIN correos_principales cp ON cp.id=ca.correo_principal_id WHERE ca.vendedor_id=$1 ORDER BY ca.creado_at DESC'
      : 'SELECT ca.*, cp.correo as principal, v.nombre as vendedor_nombre FROM correos_alias ca JOIN correos_principales cp ON cp.id=ca.correo_principal_id JOIN vendedores v ON v.id=ca.vendedor_id ORDER BY ca.creado_at DESC';
    const params = vendedor_id ? [vendedor_id] : [];
    const { rows } = await pool.query(q, params);
    return res.json({ ok: true, data: rows });
  }

  // ── LOGS ──
  if (action === 'logs') {
    const { rows } = await pool.query(
      `SELECT l.*, v.nombre as vendedor_nombre 
       FROM logs l LEFT JOIN vendedores v ON v.id=l.vendedor_id 
       ORDER BY l.creado_at DESC LIMIT 100`
    );
    return res.json({ ok: true, data: rows });
  }

  // ── TRANSACCIONES ──
  if (action === 'transacciones-list') {
    const { rows } = await pool.query(
      `SELECT t.*, v.nombre as vendedor_nombre 
       FROM transacciones t JOIN vendedores v ON v.id=t.vendedor_id 
       ORDER BY t.creado_at DESC LIMIT 50`
    );
    return res.json({ ok: true, data: rows });
  }

  if (action === 'transaccion-add') {
    const { vendedor_id, monto, metodo, descripcion } = body;
    await pool.query(
      'INSERT INTO transacciones (vendedor_id,monto,metodo,descripcion) VALUES ($1,$2,$3,$4)',
      [vendedor_id, monto, metodo || 'yape', descripcion]
    );
    return res.json({ ok: true });
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

  return res.status(404).json({ error: 'Acción no encontrada.' });
};
