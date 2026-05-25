const pool = require('./_db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { slug } = req.query;
  if (!slug) return res.json({ error: 'Falta el slug.' });

  const { rows } = await pool.query(
    'SELECT nombre, slug, foto_url, color, estado FROM vendedores WHERE slug=$1 AND estado=\'activo\'',
    [slug]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado.' });

  return res.json({ ok: true, vendedor: rows[0] });
};
