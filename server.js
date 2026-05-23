// LiquidTurn — Servidor Express + JSON store + SSE
// Sistema de turnos para liquidación de gastos de vendedores Kazen

const express = require('express');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN;

// ---------- Almacenamiento (JSON local, sin dependencias nativas) ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'liquidturn.json');

let store = { ultimoId: 0, tickets: [] };

function cargarStore() {
  if (fs.existsSync(DB_FILE)) {
    try {
      store = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      if (!store.tickets) store.tickets = [];
      if (typeof store.ultimoId !== 'number') store.ultimoId = 0;
    } catch (e) {
      console.error('Error leyendo BD, empezando vacío:', e.message);
      store = { ultimoId: 0, tickets: [] };
    }
  }
}

let pendienteGuardar = null;
function guardarStore() {
  // Debounce: agrupa escrituras seguidas en una sola
  if (pendienteGuardar) clearTimeout(pendienteGuardar);
  pendienteGuardar = setTimeout(() => {
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('Error guardando BD:', e.message);
    }
    pendienteGuardar = null;
  }, 50);
}

cargarStore();

// estado posible: 'esperando' | 'atendiendo' | 'terminado' | 'cancelado'

// Devuelve YYYY-MM-DD en zona horaria de México (CDMX = UTC-6)
function fechaHoy() {
  const ahora = new Date();
  const offset = -6 * 60; // minutos
  const local = new Date(ahora.getTime() + offset * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

function ahoraISO() {
  return new Date().toISOString();
}

function siguienteNumero() {
  const hoy = fechaHoy();
  const numeros = store.tickets.filter(t => t.fecha === hoy).map(t => t.numero);
  return (numeros.length ? Math.max(...numeros) : 0) + 1;
}

function obtenerTicket(id) {
  const num = Number(id);
  return store.tickets.find(t => t.id === num) || null;
}

function ticketsEnEspera() {
  const hoy = fechaHoy();
  return store.tickets
    .filter(t => t.fecha === hoy && t.estado === 'esperando')
    .sort((a, b) => a.id - b.id);
}

function ticketAtendiendo() {
  const hoy = fechaHoy();
  const v = store.tickets
    .filter(t => t.fecha === hoy && t.estado === 'atendiendo')
    .sort((a, b) => b.id - a.id);
  return v[0] || null;
}

function posicionEnFila(ticket) {
  if (!ticket) return null;
  if (ticket.estado !== 'esperando') return 0;
  return store.tickets.filter(
    t => t.fecha === ticket.fecha && t.estado === 'esperando' && t.id < ticket.id
  ).length;
}

function resumenCola() {
  const hoy = fechaHoy();
  const delDia = store.tickets.filter(t => t.fecha === hoy);
  return {
    fecha: hoy,
    espera: delDia.filter(t => t.estado === 'esperando').length,
    atendiendo: delDia.filter(t => t.estado === 'atendiendo').length,
    terminados: delDia.filter(t => t.estado === 'terminado').length,
  };
}

function crearTicket({ nombre, ruta, celular }) {
  const ticket = {
    id: ++store.ultimoId,
    numero: siguienteNumero(),
    fecha: fechaHoy(),
    nombre,
    ruta,
    celular,
    estado: 'esperando',
    creado_en: ahoraISO(),
    llamado_en: null,
    terminado_en: null,
  };
  store.tickets.push(ticket);
  guardarStore();
  return ticket;
}

function actualizarTicket(id, cambios) {
  const t = obtenerTicket(id);
  if (!t) return null;
  Object.assign(t, cambios);
  guardarStore();
  return t;
}

// ---------- Server-Sent Events ----------
const sseClients = new Set();

function broadcast(evento, data) {
  const payload = `event: ${evento}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { /* ignorar */ }
  }
}

function notifyAll() {
  broadcast('update', { ts: Date.now() });
}

// ---------- App ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API ---

app.post('/api/tickets', (req, res) => {
  const { nombre, ruta, celular } = req.body || {};
  if (!nombre || !ruta || !celular) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  const celNormalizado = String(celular).replace(/\D/g, '');
  if (celNormalizado.length < 10) {
    return res.status(400).json({ error: 'El celular debe tener al menos 10 dígitos' });
  }
  const ticket = crearTicket({
    nombre: String(nombre).trim(),
    ruta: String(ruta).trim(),
    celular: celNormalizado,
  });
  notifyAll();
  res.json({ ticket });
});

app.get('/api/tickets/:id', (req, res) => {
  const ticket = obtenerTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
  const adelante = posicionEnFila(ticket);
  res.json({ ticket, adelante });
});

app.post('/api/tickets/:id/cancelar', (req, res) => {
  const ticket = obtenerTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
  if (ticket.estado !== 'esperando') {
    return res.status(400).json({ error: 'Solo se pueden cancelar tickets en espera' });
  }
  actualizarTicket(ticket.id, { estado: 'cancelado' });
  notifyAll();
  res.json({ ok: true });
});

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  res.write(': conectado\n\n');

  sseClients.add(res);

  const hb = setInterval(() => {
    try { res.write(': hb\n\n'); } catch (e) { clearInterval(hb); }
  }, 25000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
});

// --- API Admin ---
function requiereAdmin(req, res, next) {
  const pin = req.get('x-admin-pin') || req.query.pin;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'PIN incorrecto' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { pin } = req.body || {};
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'PIN incorrecto' });
  res.json({ ok: true });
});

app.get('/api/admin/estado', requiereAdmin, (req, res) => {
  res.json({
    resumen: resumenCola(),
    atendiendo: ticketAtendiendo(),
    espera: ticketsEnEspera(),
  });
});

app.post('/api/admin/llamar-siguiente', requiereAdmin, (req, res) => {
  const actual = ticketAtendiendo();
  if (actual) {
    return res.status(400).json({
      error: 'Ya hay un turno en atención. Termínelo antes de llamar al siguiente.',
    });
  }
  const siguientes = ticketsEnEspera();
  if (siguientes.length === 0) {
    return res.status(400).json({ error: 'No hay turnos en espera' });
  }
  const t = siguientes[0];
  actualizarTicket(t.id, { estado: 'atendiendo', llamado_en: ahoraISO() });
  notifyAll();
  // Aquí se podría disparar un SMS real (Twilio) — el ticket que pasa a atención es `t`.
  res.json({ ticket: obtenerTicket(t.id) });
});

app.post('/api/admin/terminar', requiereAdmin, (req, res) => {
  const actual = ticketAtendiendo();
  if (!actual) return res.status(400).json({ error: 'No hay turno en atención' });
  actualizarTicket(actual.id, { estado: 'terminado', terminado_en: ahoraISO() });
  notifyAll();
  res.json({ ok: true });
});

app.post('/api/admin/reiniciar-dia', requiereAdmin, (req, res) => {
  const hoy = fechaHoy();
  for (const t of store.tickets) {
    if (t.fecha === hoy && (t.estado === 'esperando' || t.estado === 'atendiendo')) {
      t.estado = 'cancelado';
    }
  }
  guardarStore();
  notifyAll();
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`LiquidTurn corriendo en http://localhost:${PORT}`);
  console.log(`PIN admin: ${ADMIN_PIN}`);
});
