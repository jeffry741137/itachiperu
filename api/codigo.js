const Imap = require('imap');
const { simpleParser } = require('mailparser');
const pool = require('./_db');

const MINUTOS_VALIDOS = 5;

const FILTROS = {
  netflix_hogar:    ['hogar', 'household', 'ubicación', 'tv de tu hogar', 'actualiza tu hogar'],
  netflix_login:    ['código de inicio de sesión', 'sign-in code', 'inicio de sesión'],
  netflix_pass:     ['restablece', 'restablecer', 'reset', 'contraseña', 'password'],
  netflix_pin:      ['código de verificación', 'verification code', 'confirma el cambio', 'pin'],
  netflix_temporal: ['código de acceso temporal', 'temporary access code', 'acceso temporal'],
  disney:           ['código', 'code', 'verificación', 'verification'],
};

function limpiarLink(url) {
  return url.replace(/[\]"'\s>\\)]+$/, '').trim();
}

function buscarEmailsImap(palabrasClave, aliasCliente, imapUser, imapPass) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: imapUser, password: imapPass,
      host: 'imap.mail.me.com', port: 993, tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000, authTimeout: 10000,
    });

    const ahora   = new Date();
    const limite  = new Date(ahora.getTime() - MINUTOS_VALIDOS * 60 * 1000);
    const diezMin = new Date(ahora.getTime() - 10 * 60 * 1000);
    const fechaImap = diezMin.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).replace(',', '');

    function buscarEnCarpeta(carpeta) {
      return new Promise((resolveBox) => {
        imap.openBox(carpeta, true, (err) => {
          if (err) return resolveBox([]);
          imap.search(['ALL', ['SINCE', fechaImap]], (err, uids) => {
            if (err || !uids || uids.length === 0) return resolveBox([]);
            const fetch = imap.fetch(uids.slice(-15), { bodies: '' });
            const emails = [];
            const parsePromises = [];
            fetch.on('message', (msg) => {
              let buffer = '';
              msg.on('body', (stream) => {
                stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
                stream.once('end', () => {
                  const p = simpleParser(buffer).then(parsed => emails.push(parsed)).catch(() => {});
                  parsePromises.push(p);
                });
              });
            });
            fetch.once('error', () => resolveBox([]));
            fetch.once('end', () => {
              setTimeout(async () => {
                await Promise.allSettled(parsePromises);
                resolveBox(emails);
              }, 1500);
            });
          });
        });
      });
    }

    imap.once('ready', () => {
      imap.getBoxes((err, boxes) => {
        const carpetas = ['INBOX'];
        if (!err && boxes) {
          if (boxes.INBOX && boxes.INBOX.children) {
            Object.keys(boxes.INBOX.children).forEach(sub => carpetas.push('INBOX.' + sub));
          }
          ['Novedades','Transacciones','Promociones','Principal'].forEach(f => {
            if (boxes[f]) carpetas.push(f);
          });
        }
        (async () => {
          try {
            let todos = [];
            for (const carpeta of carpetas) {
              const mails = await buscarEnCarpeta(carpeta).catch(() => []);
              todos = todos.concat(mails);
            }
            imap.end();
            const filtrados = todos.filter(mail => {
              const fecha = mail.date ? new Date(mail.date) : new Date(0);
              if (fecha < limite) return false;
              const asunto = (mail.subject || '').toLowerCase();
              if (!palabrasClave.some(p => asunto.includes(p.toLowerCase()))) return false;
              const cuerpo = (mail.text || '') + ' ' + (mail.html || '');
              return cuerpo.toLowerCase().includes(aliasCliente.toLowerCase());
            });
            filtrados.sort((a, b) => new Date(b.date) - new Date(a.date));
            resolve(filtrados);
          } catch(e) { imap.end(); resolve([]); }
        })();
      });
    });
    imap.once('error', (err) => reject(err));
    imap.connect();
  });
}

function extraerValor(servicio, cuerpo) {
  if (servicio === 'netflix_hogar') {
    const patrones = [
      /https:\/\/www\.netflix\.com\/account\/travel\/[^\s"'<>\)\\]+/gi,
      /https:\/\/www\.netflix\.com\/[^\s"'<>\)\\]*travel[^\s"'<>\)\\]+/gi,
      /https:\/\/www\.netflix\.com\/account\/[^\s"'<>\)\\]{30,}/gi,
    ];
    for (const p of patrones) {
      const m = cuerpo.match(p);
      if (m?.[0]) return { valor: limpiarLink(m[0]), tipo: 'link' };
    }
  }
  if (servicio === 'netflix_login') {
    const patrones = [
      /c[oó]digo de inicio de sesi[oó]n[^0-9]*([0-9]{4,6})/i,
      /sign.in code[^0-9]*([0-9]{4,6})/i,
      /c[oó]digo[^0-9]*([0-9]{4,6})/i,
      />\s*([0-9]{4,6})\s*</,
      /\b([0-9]{6})\b/,
      /\b([0-9]{4})\b/,
    ];
    for (const p of patrones) {
      const m = cuerpo.match(p);
      if (m) return { valor: m[1], tipo: 'codigo' };
    }
  }
  if (servicio === 'netflix_pass') {
    const patrones = [
      /https:\/\/www\.netflix\.com\/password[^\s"'<>\)\[\]\\]*/gi,
      /https:\/\/www\.netflix\.com\/[^\s"'<>\)\[\]\\]*password[^\s"'<>\)\[\]\\]*/gi,
      /https:\/\/www\.netflix\.com\/[^\s"'<>\)\[\]\\]*reset[^\s"'<>\)\[\]\\]*/gi,
      /https:\/\/www\.netflix\.com\/account\/[^\s"'<>\)\[\]\\]{30,}/gi,
    ];
    for (const p of patrones) {
      const m = cuerpo.match(p);
      if (m?.[0]) return { valor: limpiarLink(m[0]), tipo: 'link' };
    }
  }
  if (servicio === 'netflix_pin') {
    const patrones = [
      /c[oó]digo de verificaci[oó]n[^0-9]*([0-9]{6})/i,
      /confirma el cambio[^0-9]*([0-9]{6})/i,
      /ingresa este c[oó]digo[^0-9]*([0-9]{6})/i,
      />\s*([0-9]{6})\s*</,
      /\b([0-9]{6})\b/,
    ];
    for (const p of patrones) {
      const m = cuerpo.match(p);
      if (m) return { valor: m[1], tipo: 'codigo' };
    }
  }
  if (servicio === 'netflix_temporal') {
    const patrones = [
      /https:\/\/www\.netflix\.com\/account\/travel\/verify[^\s"'<>\)\[\]\\]*/gi,
      /https:\/\/www\.netflix\.com\/[^\s"'<>\)\[\]\\]*travel\/verify[^\s"'<>\)\[\]\\]*/gi,
    ];
    for (const p of patrones) {
      const m = cuerpo.match(p);
      if (m?.[0]) return { valor: limpiarLink(m[0]), tipo: 'link' };
    }
  }
  if (servicio === 'disney') {
    const patrones = [
      /c[oó]digo[^0-9]*([0-9]{6})/i,
      />\s*([0-9]{6})\s*</,
      /\b([0-9]{6})\b/,
    ];
    for (const p of patrones) {
      const m = cuerpo.match(p);
      if (m) return { valor: m[1], tipo: 'codigo' };
    }
  }
  return null;
}

function mensajeVacio(s) {
  const msgs = {
    netflix_hogar:    'No hay email de Hogar en los últimos 5 min. Solicítalo desde Netflix.',
    netflix_login:    'No hay código de inicio de sesión en los últimos 5 min.',
    netflix_pass:     'No hay email de restablecimiento en los últimos 5 min.',
    netflix_pin:      'No hay código PIN de verificación en los últimos 5 min.',
    netflix_temporal: 'No hay email de código temporal en los últimos 5 min. Solicítalo desde Netflix.',
    disney:           'No hay código de Disney+ en los últimos 5 min.',
  };
  return msgs[s] || 'No hay código disponible.';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { servicio, correo, slug } = req.query;
  if (!servicio || !correo) return res.json({ error: 'Faltan parámetros.' });

  const correoLower = correo.toLowerCase().trim();

  if (!slug) return res.json({ error: 'Acceso no válido. Usa el link de tu vendedor.' });

  const { rows } = await pool.query(`
    SELECT ca.alias, ca.servicio, cp.correo as icloud_user, cp.password_app as icloud_pass
    FROM correos_alias ca
    JOIN correos_principales cp ON cp.id = ca.correo_principal_id
    JOIN vendedores v ON v.id = ca.vendedor_id
    WHERE ca.alias = $1
      AND v.slug = $2
      AND ca.activo = TRUE
      AND cp.activo = TRUE
      AND v.estado = 'activo'
      AND v.licencia_fin > NOW()
  `, [correoLower, slug]);

  const cuenta = rows[0];
  if (!cuenta) return res.json({ error: 'Correo no registrado o licencia expirada.' });

  const esNetflix = ['netflix_hogar','netflix_login','netflix_pass','netflix_pin','netflix_temporal'].includes(servicio);
  const ok =
    (cuenta.servicio === 'netflix' && esNetflix) ||
    (cuenta.servicio === 'disney'  && servicio === 'disney');

  if (!ok) return res.json({ error: 'Este correo no corresponde al servicio solicitado.' });

  try {
    const emails = await buscarEmailsImap(FILTROS[servicio], correoLower, cuenta.icloud_user, cuenta.icloud_pass);
    if (!emails || emails.length === 0) return res.json({ error: mensajeVacio(servicio) });

    const mail    = emails[0];
    const cuerpo  = (mail.text || '') + ' ' + (mail.html || '');
    const resultado = extraerValor(servicio, cuerpo);
    if (!resultado) return res.json({ error: 'No se encontró el código en el email.' });

    return res.json({
      success: true,
      valor:   resultado.valor,
      tipo:    resultado.tipo,
      asunto:  mail.subject || '',
      fecha:   mail.date ? new Date(mail.date).toISOString() : new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error IMAP:', err.message);
    return res.json({ error: 'Error al conectar con el correo. Intenta de nuevo.' });
  }
};
