/* ============================================================
   Untis Planer - Weboberflaeche

   Diese Seite hat keinen eigenen Server. Sie liest den privaten
   Datenbestand direkt ueber die GitHub-API:

     Zweig 'handy' : Untis-Termine.json  - Termine und drei Wochen Stundenplan
     Zweig 'main'  : userdata.json       - Notizen, eigene Eintraege, Einstellungen

   Geschrieben wird nur userdata.json, und zwar immer so: frischen Stand
   holen, die eigene Aenderung hineinlegen, zurueckschreiben. Damit geht
   nichts verloren, wenn zwischendurch ein PC etwas abgelegt hat.

   Das Token bleibt in diesem Browser (localStorage) und wird
   ausschliesslich an api.github.com geschickt.
   ============================================================ */

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const WD  = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MON = ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
             'August', 'September', 'Oktober', 'November', 'Dezember'];

const FARBE = {
  'Schularbeit':   '#e5484d',
  'Test':          '#e5484d',
  'Pruefung':      '#e5484d',
  'Prüfung':       '#e5484d',
  'Hausaufgabe':   '#2ba360',
  'Abgabe':        '#0f7ae5',
  'Referat':       '#8e4ec6',
  'Veranstaltung': '#0d9488',
  'Termin':        '#7c8394'
};
const farbeVon = art => FARBE[art] || '#7c8394';

/* ---------------- Zustand ---------------- */

let zugang  = { repo: '', token: '' };
let daten   = null;    // Untis-Termine.json vom Zweig 'handy'
let nutzer  = null;    // userdata.json vom Zweig 'main'
let nutzerSha = '';
let spWoche = null;    // Montag der angezeigten Woche
let calMonat = null;   // erster Tag des angezeigten Monats
let gewaehlterTag = null;
let offen   = null;    // was gerade im Dialog steht

/* ---------------- Kleinkram ---------------- */

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const zweiStellig = n => String(n).padStart(2, '0');
const toIso = d => `${d.getFullYear()}-${zweiStellig(d.getMonth() + 1)}-${zweiStellig(d.getDate())}`;
const vonIso = s => new Date(s + 'T12:00:00');
const minuten = t => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : null;
};
const montagVon = d => {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const heuteIso = () => toIso(new Date());
const langesDatum = iso => {
  const d = vonIso(iso);
  return `${WD[d.getDay()]}, ${d.getDate()}. ${MON[d.getMonth()]} ${d.getFullYear()}`;
};
const stempel = () => new Date().toISOString();

function blase(text, art) {
  const el = document.createElement('div');
  el.className = 'blase' + (art ? ' ' + art : '');
  el.textContent = text;
  $('#flash').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ---------------- GitHub ---------------- */

const nachB64 = s => {
  const bytes = new TextEncoder().encode(s);
  let roh = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    roh += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(roh);
};
const ausB64 = b => new TextDecoder().decode(
  Uint8Array.from(atob(String(b).replace(/\s/g, '')), c => c.charCodeAt(0)));

async function ghHole(pfad, zweig) {
  const url = `https://api.github.com/repos/${zugang.repo}/contents/${pfad}?ref=${zweig}&_=${Date.now()}`;
  const r = await fetch(url, {
    cache: 'no-store',
    headers: {
      'Authorization': 'Bearer ' + zugang.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!r.ok) throw new Error(await fehlertext(r, pfad));
  const j = await r.json();
  return { inhalt: JSON.parse(ausB64(j.content)), sha: j.sha };
}

async function ghSchreibe(pfad, objekt, sha, nachricht) {
  const r = await fetch(`https://api.github.com/repos/${zugang.repo}/contents/${pfad}`, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + zugang.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: nachricht || 'Änderung aus der Weboberfläche',
      content: nachB64(JSON.stringify(objekt, null, 2)),
      sha: sha,
      branch: 'main'
    })
  });
  if (!r.ok) {
    const e = new Error(await fehlertext(r, pfad));
    e.status = r.status;
    throw e;
  }
  const j = await r.json();
  return j.content.sha;
}

async function fehlertext(r, pfad) {
  let extra = '';
  try { extra = (await r.json()).message || ''; } catch (e) { /* egal */ }
  if (r.status === 401) return 'Token abgelehnt (401). Bitte unter „Zugang“ neu eintragen.';
  if (r.status === 403) return 'Keine Berechtigung (403). Hat das Token Contents-Rechte für dieses Repository?';
  if (r.status === 404) return `Nicht gefunden: ${pfad} (404). Stimmt der Repository-Name?`;
  if (r.status === 409) return 'Inzwischen hat ein anderes Gerät geschrieben (409).';
  return `GitHub meldet ${r.status}. ${extra}`;
}

/* ---------------- Laden ---------------- */

async function ladeAlles(still) {
  if (!zugang.repo || !zugang.token) { zeigeAnsicht('zugang'); return; }
  $('#kopfStand').textContent = 'lädt …';
  try {
    const [h, m] = await Promise.all([
      ghHole('Untis-Termine.json', 'handy'),
      ghHole('userdata.json', 'main')
    ]);
    daten = h.inhalt;
    nutzer = m.inhalt;
    nutzerSha = m.sha;
    for (const g of ['settings', 'entries', 'manual', 'stundenNotizen']) {
      if (!nutzer[g]) nutzer[g] = {};
    }
    if (!spWoche) spWoche = montagVon(new Date());
    zeichneAlles();
    const wann = daten.generiert ? new Date(daten.generiert) : null;
    $('#kopfStand').textContent = wann
      ? `Stand ${zweiStellig(wann.getDate())}.${zweiStellig(wann.getMonth() + 1)}. ${zweiStellig(wann.getHours())}:${zweiStellig(wann.getMinutes())}`
      : 'geladen';
    if (!still) blase('Geladen.', 'gut');
  } catch (err) {
    $('#kopfStand').textContent = 'nicht geladen';
    blase(err.message, 'schlecht');
    if (/401|403|404/.test(err.message)) zeigeAnsicht('zugang');
  }
}

/* Aendern heisst immer: frisch holen, hineinlegen, zurueckschreiben.
   So ueberschreibt die Seite nichts, was ein PC in der Zwischenzeit ablegte. */
async function aendereNutzerdaten(aenderung, nachricht) {
  for (let versuch = 1; versuch <= 2; versuch++) {
    const frisch = await ghHole('userdata.json', 'main');
    const stand = frisch.inhalt;
    for (const g of ['settings', 'entries', 'manual', 'stundenNotizen']) {
      if (!stand[g]) stand[g] = {};
    }
    aenderung(stand);
    try {
      nutzerSha = await ghSchreibe('userdata.json', stand, frisch.sha, nachricht);
      nutzer = stand;
      return true;
    } catch (err) {
      if (err.status === 409 && versuch === 1) continue;   // jemand war schneller
      throw err;
    }
  }
  return false;
}

/* ---------------- Termine ---------------- */

// Der Termin, wie ihn die Seite zeigt: Grunddaten aus der Handy-Datei,
// Notiz und Erledigt-Haken aus userdata.json (die sind dort immer frischer).
function termineListe() {
  const roh = (daten && daten.termine) || [];
  return roh.map(t => {
    const zusatz = (nutzer.entries && nutzer.entries[t.id]) || {};
    const eigen  = (nutzer.manual && nutzer.manual[t.id]) || null;
    return {
      id: t.id,
      titel: eigen ? (eigen.title || t.titel) : t.titel,
      fach: t.fach,
      art: eigen ? (eigen.category || t.art) : t.art,
      datum: eigen ? (eigen.date || t.datum) : t.datum,
      von: eigen ? (eigen.startTime || '') : t.von,
      bis: eigen ? (eigen.endTime || '') : t.bis,
      lehrkraft: t.lehrkraft,
      raum: t.raum,
      text: t.text,
      notiz: zusatz.notes !== undefined ? zusatz.notes : (eigen ? eigen.notes : t.notiz),
      erledigt: zusatz.done !== undefined ? !!zusatz.done : !!t.erledigt,
      versteckt: !!zusatz.hidden,
      wichtig: !!t.wichtig || !!t.eigener,
      eigener: !!t.eigener || !!eigen
    };
  }).filter(t => !t.versteckt);
}

function zeichneTermine() {
  const zeigeErledigte = $('#fErledigte').checked;
  const nurWichtige = $('#fNurWichtige').checked;
  const heute = heuteIso();
  const liste = termineListe()
    .filter(t => t.datum >= heute)
    .filter(t => zeigeErledigte || !t.erledigt)
    .filter(t => !nurWichtige || t.wichtig)
    .sort((a, b) => (a.datum + (a.von || '')).localeCompare(b.datum + (b.von || '')));

  if (!liste.length) {
    $('#terminListe').innerHTML = '<p class="dim">Nichts eingetragen.</p>';
    return;
  }

  const tage = new Map();
  liste.forEach(t => {
    if (!tage.has(t.datum)) tage.set(t.datum, []);
    tage.get(t.datum).push(t);
  });

  let html = '';
  for (const [datum, eintraege] of tage) {
    const tage_hin = Math.round((vonIso(datum) - vonIso(heute)) / 86400000);
    const wann = tage_hin === 0 ? 'heute' : tage_hin === 1 ? 'morgen' : `in ${tage_hin} Tagen`;
    html += `<div class="taggruppe">
      <div class="tagkopf${datum === heute ? ' heute' : ''}">
        <b>${esc(langesDatum(datum))}</b><span class="dim">${esc(wann)}</span>
      </div>`;
    for (const t of eintraege) {
      html += `<div class="termin${t.erledigt ? ' erledigt' : ''}" style="--cat:${farbeVon(t.art)}" data-id="${esc(t.id)}">
        <input type="checkbox" class="haken" data-haken="${esc(t.id)}" ${t.erledigt ? 'checked' : ''}>
        <div style="flex:1">
          <div class="titel">${esc(t.titel)}</div>
          <div class="unten">${esc(t.art)}${t.von ? ' · ' + esc(t.von) + (t.bis ? '–' + esc(t.bis) : '') : ''}${t.raum ? ' · ' + esc(t.raum) : ''}${t.lehrkraft ? ' · ' + esc(t.lehrkraft) : ''}</div>
          ${t.notiz ? `<div class="notiz">${esc(t.notiz)}</div>` : ''}
        </div>
      </div>`;
    }
    html += '</div>';
  }
  $('#terminListe').innerHTML = html;

  $$('#terminListe .termin').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.matches('[data-haken]')) return;
      zeigeTermin(el.dataset.id);
    });
  });
  $$('#terminListe [data-haken]').forEach(el => {
    el.addEventListener('change', () => setzeErledigt(el.dataset.haken, el.checked));
  });
}

async function setzeErledigt(id, erledigt) {
  try {
    await aendereNutzerdaten(stand => {
      const e = stand.entries[id] || {};
      e.done = !!erledigt;
      e.updatedAt = stempel();
      stand.entries[id] = e;
    }, `${erledigt ? 'Erledigt' : 'Offen'}: ${id}`);
    zeichneAlles();
    blase(erledigt ? 'Als erledigt gespeichert.' : 'Wieder offen.', 'gut');
  } catch (err) {
    blase(err.message, 'schlecht');
    zeichneTermine();
  }
}

/* ---------------- Dialog: Termin ---------------- */

function zeigeTermin(id) {
  const t = termineListe().find(x => x.id === id);
  if (!t) return;
  offen = { art: 'termin', id, eigener: t.eigener };

  $('#mTitel').textContent = t.titel;
  let html = `<dl class="feld">
    <dt>Wann</dt><dd>${esc(langesDatum(t.datum))}${t.von ? ', ' + esc(t.von) + (t.bis ? '–' + esc(t.bis) : '') : ''}</dd>
    <dt>Art</dt><dd>${esc(t.art)}</dd>
    ${t.fach ? `<dt>Fach</dt><dd>${esc(t.fach)}</dd>` : ''}
    ${t.raum ? `<dt>Raum</dt><dd>${esc(t.raum)}</dd>` : ''}
    ${t.lehrkraft ? `<dt>Lehrkraft</dt><dd>${esc(t.lehrkraft)}</dd>` : ''}
    ${t.text ? `<dt>Aus Untis</dt><dd>${esc(t.text)}</dd>` : ''}
  </dl>`;

  if (t.eigener) {
    const e = (nutzer.manual && nutzer.manual[id]) || {};
    html += `
      <label for="fTitel">Titel</label>
      <input id="fTitel" type="text" value="${esc(e.title || t.titel)}">
      <div style="display:flex; gap:10px">
        <div style="flex:1"><label for="fDatum">Datum</label><input id="fDatum" type="date" value="${esc(e.date || t.datum)}"></div>
        <div style="width:110px"><label for="fVon">Von</label><input id="fVon" type="time" value="${esc(e.startTime || '')}"></div>
        <div style="width:110px"><label for="fBis">Bis</label><input id="fBis" type="time" value="${esc(e.endTime || '')}"></div>
      </div>`;
  }
  html += `<label for="fNotiz">Meine Notiz</label>
    <textarea id="fNotiz" placeholder="Was ist zu tun? Was brauche ich?">${esc(t.notiz || '')}</textarea>`;

  $('#mInhalt').innerHTML = html;
  $('#mSpeichern').hidden = false;
  $('#mLoeschen').hidden = !t.eigener;
  $('#overlay').classList.add('offen');
}

function zeigeNeuerTermin() {
  offen = { art: 'neu' };
  $('#mTitel').textContent = 'Eigener Termin';
  $('#mInhalt').innerHTML = `
    <label for="fTitel">Titel</label>
    <input id="fTitel" type="text" placeholder="z. B. Sexual Workshop">
    <div style="display:flex; gap:10px">
      <div style="flex:1"><label for="fDatum">Datum</label><input id="fDatum" type="date" value="${heuteIso()}"></div>
      <div style="width:110px"><label for="fVon">Von</label><input id="fVon" type="time"></div>
      <div style="width:110px"><label for="fBis">Bis</label><input id="fBis" type="time"></div>
    </div>
    <label for="fArt">Art</label>
    <select id="fArt">
      ${['Termin', 'Veranstaltung', 'Abgabe', 'Referat', 'Test', 'Schularbeit', 'Hausaufgabe']
        .map(a => `<option>${a}</option>`).join('')}
    </select>
    <label for="fNotiz">Notiz</label>
    <textarea id="fNotiz"></textarea>`;
  $('#mSpeichern').hidden = false;
  $('#mLoeschen').hidden = true;
  $('#overlay').classList.add('offen');
}

/* ---------------- Dialog: Stunde ---------------- */

function zeigeStunde(id) {
  const stunden = wochenStunden();
  const s = stunden.find(x => String(x.id) === String(id));
  if (!s) return;
  offen = { art: 'stunde', id: String(s.id), teile: (s.teile || []).map(String), stunde: s };

  $('#mTitel').textContent = `${s.fach || s.fachLang || 'Stunde'} · ${s.von}`;
  const notiz = notizZurStunde(s);
  $('#mInhalt').innerHTML = `<dl class="feld">
      <dt>Wann</dt><dd>${esc(langesDatum(s.datum))}, ${esc(s.von)}–${esc(s.bis)}</dd>
      ${s.fachLang ? `<dt>Fach</dt><dd>${esc(s.fachLang)}</dd>` : ''}
      ${s.lehrer ? `<dt>Lehrkraft</dt><dd>${esc(s.lehrer)}${s.lehrerOrg ? ' (statt ' + esc(s.lehrerOrg) + ')' : ''}</dd>` : ''}
      ${s.raum ? `<dt>Raum</dt><dd>${esc(s.raum)}${s.raumOrg ? ' (statt ' + esc(s.raumOrg) + ')' : ''}</dd>` : ''}
      ${s.status && s.status !== 'normal' ? `<dt>Status</dt><dd>${esc(s.status)}</dd>` : ''}
      ${s.info || s.text ? `<dt>Aus Untis</dt><dd>${esc([s.info, s.text].filter(Boolean).join(' · '))}</dd>` : ''}
    </dl>
    <label for="fNotiz">Meine Notiz zu dieser Stunde</label>
    <textarea id="fNotiz" placeholder="Was wurde durchgenommen? Was mitbringen?">${esc(notiz ? notiz.notiz : '')}</textarea>
    <p class="dim" style="margin:8px 0 0">Gilt nur für diese Stunde an diesem Tag und erscheint auf allen deinen Geräten.</p>`;
  $('#mSpeichern').hidden = false;
  $('#mLoeschen').hidden = true;
  $('#overlay').classList.add('offen');
}

function notizZurStunde(s) {
  const alle = (nutzer && nutzer.stundenNotizen) || {};
  for (const id of [s.id].concat(s.teile || [])) {
    const n = alle[String(id)];
    if (n && n.notiz) return n;
  }
  return null;
}

/* ---------------- Speichern aus dem Dialog ---------------- */

async function speichern() {
  if (!offen) return;
  const knopf = $('#mSpeichern');
  knopf.disabled = true;
  try {
    if (offen.art === 'stunde') {
      const text = $('#fNotiz').value.trimEnd();
      const s = offen.stunde;
      await aendereNutzerdaten(stand => {
        // Bei zusammengefassten Bloecken die anderen Teile leeren,
        // damit die Notiz nicht doppelt erscheint
        for (const teil of (s.teile || []).map(String)) {
          if (teil !== offen.id && stand.stundenNotizen[teil]) {
            stand.stundenNotizen[teil] = { ...stand.stundenNotizen[teil], notiz: '', updatedAt: stempel() };
          }
        }
        stand.stundenNotizen[offen.id] = {
          notiz: text, datum: s.datum, von: s.von, fach: s.fach || '', updatedAt: stempel()
        };
      }, `Stundennotiz ${s.datum} ${s.von}`);
    } else if (offen.art === 'neu') {
      const titel = $('#fTitel').value.trim();
      if (!titel) { blase('Bitte einen Titel eintragen.', 'schlecht'); knopf.disabled = false; return; }
      const id = 'manual-' + Date.now().toString(36);
      await aendereNutzerdaten(stand => {
        stand.manual[id] = {
          id, source: 'manual', title: titel, category: $('#fArt').value,
          subject: $('#fArt').value, date: $('#fDatum').value,
          startTime: $('#fVon').value || '', endTime: $('#fBis').value || '',
          notes: $('#fNotiz').value.trimEnd(), text: '', teachers: '', rooms: '',
          typeLabel: 'Eigener Termin', important: true, done: false, hidden: false,
          notified: [], reminderDays: null,
          createdAt: stempel(), updatedAt: stempel()
        };
      }, `Eigener Termin: ${titel}`);
      blase('Angelegt. Der PC übernimmt ihn beim nächsten Abgleich.', 'gut');
    } else if (offen.art === 'termin') {
      const notiz = $('#fNotiz').value.trimEnd();
      const id = offen.id;
      const titel = $('#fTitel') ? $('#fTitel').value.trim() : null;
      await aendereNutzerdaten(stand => {
        if (offen.eigener && stand.manual[id]) {
          const m = stand.manual[id];
          if (titel) m.title = titel;
          if ($('#fDatum')) m.date = $('#fDatum').value;
          if ($('#fVon')) m.startTime = $('#fVon').value || '';
          if ($('#fBis')) m.endTime = $('#fBis').value || '';
          m.notes = notiz;
          m.updatedAt = stempel();
        } else {
          const e = stand.entries[id] || {};
          e.notes = notiz;
          e.updatedAt = stempel();
          stand.entries[id] = e;
        }
      }, `Notiz: ${id}`);
    }
    schliesseDialog();
    await ladeAlles(true);
    blase('Gespeichert.', 'gut');
  } catch (err) {
    blase(err.message, 'schlecht');
  } finally {
    knopf.disabled = false;
  }
}

async function loeschen() {
  if (!offen || offen.art !== 'termin' || !offen.eigener) return;
  if (!confirm('Diesen eigenen Termin wirklich löschen?')) return;
  try {
    await aendereNutzerdaten(stand => {
      if (stand.manual[offen.id]) {
        // Nicht wegwerfen, sondern verstecken - sonst legt der PC ihn
        // beim naechsten Abgleich wieder an
        stand.manual[offen.id].hidden = true;
        stand.manual[offen.id].updatedAt = stempel();
      }
      const e = stand.entries[offen.id] || {};
      e.hidden = true;
      e.updatedAt = stempel();
      stand.entries[offen.id] = e;
    }, `Eigener Termin entfernt: ${offen.id}`);
    schliesseDialog();
    await ladeAlles(true);
    blase('Entfernt.', 'gut');
  } catch (err) {
    blase(err.message, 'schlecht');
  }
}

function schliesseDialog() {
  offen = null;
  $('#overlay').classList.remove('offen');
  $('#mSpeichern').hidden = true;
  $('#mLoeschen').hidden = true;
}

/* ---------------- Stundenplan ---------------- */

function wochenStunden() {
  if (!daten || !daten.stundenplan || !daten.stundenplan.wochen) return [];
  const roh = daten.stundenplan.wochen[toIso(spWoche)] || [];
  return fasseZusammen(roh);
}

/* Aufeinanderfolgende Stunden desselben Fachs zu einem Block machen -
   so wie es WebUntis auch zeigt. */
function fasseZusammen(stunden) {
  const sortiert = [...stunden].sort((a, b) =>
    (a.datum + a.von).localeCompare(b.datum + b.von));
  const raus = [];
  for (const s of sortiert) {
    const vorher = raus[raus.length - 1];
    const gleich = vorher
      && vorher.datum === s.datum
      && (vorher.fach || '') === (s.fach || '')
      && (vorher.status || '') === (s.status || '')
      && (vorher.raum || '') === (s.raum || '')
      && minuten(s.von) - minuten(vorher.bis) <= 15
      && minuten(s.von) >= minuten(vorher.bis);
    if (gleich) {
      vorher.bis = s.bis;
      vorher.teile = (vorher.teile || [vorher.id]).concat([s.id]);
    } else {
      raus.push({ ...s, teile: [s.id] });
    }
  }
  return raus;
}

function eigeneBloecke() {
  const raus = [];
  for (const [id, m] of Object.entries((nutzer && nutzer.manual) || {})) {
    if (!m || m.hidden || !m.date || !m.startTime || !m.endTime) continue;
    if (minuten(m.endTime) <= minuten(m.startTime)) continue;
    raus.push({ id, titel: m.title, datum: m.date, von: m.startTime, bis: m.endTime, art: m.category || 'Termin' });
  }
  return raus;
}

function zeichneStundenplan() {
  const ende = new Date(spWoche); ende.setDate(ende.getDate() + 6);
  $('#spWoche').textContent =
    `${spWoche.getDate()}. ${MON[spWoche.getMonth()].slice(0, 3)} – ${ende.getDate()}. ${MON[ende.getMonth()].slice(0, 3)} ${ende.getFullYear()}`;

  const raster = (daten && daten.stundenplan && daten.stundenplan.raster) || [];
  const stunden = wochenStunden();
  const bloecke = eigeneBloecke().filter(b => {
    const d = vonIso(b.datum);
    return d >= spWoche && d <= ende;
  });

  if (!raster.length || (!stunden.length && !bloecke.length)) {
    $('#spGrid').innerHTML = `<p class="dim">Für diese Woche liegt kein Stundenplan bereit.
      Die Seite bekommt drei Wochen vom PC – blättere zurück oder warte den nächsten Abgleich ab.</p>`;
    $('#spHinweis').textContent = '';
    return;
  }

  const tage = 5;
  // Spuren je Tag: parallele Stunden nebeneinander statt uebereinander
  const spuren = [];
  const lage = new Map();          // id -> Spur
  for (let t = 0; t < tage; t++) {
    const datum = toIso(new Date(spWoche.getFullYear(), spWoche.getMonth(), spWoche.getDate() + t));
    const amTag = stunden.filter(s => s.datum === datum)
      .concat(bloecke.filter(b => b.datum === datum).map(b => ({ ...b, block: true })));
    const belegt = [];             // je Spur: Liste der Zeitraeume
    for (const s of amTag.sort((a, b) => minuten(a.von) - minuten(b.von))) {
      let spur = 0;
      while (true) {
        const drin = (belegt[spur] || []).some(z =>
          minuten(s.von) < z.bis && minuten(s.bis) > z.von);
        if (!drin) break;
        spur++;
      }
      if (!belegt[spur]) belegt[spur] = [];
      belegt[spur].push({ von: minuten(s.von), bis: minuten(s.bis) });
      lage.set((s.block ? 'b' : 's') + s.id, spur);
    }
    spuren.push(Math.max(1, belegt.length));
  }

  const spalteVon = [];
  let spalte = 2;                  // Spalte 1 ist die Uhrzeit
  for (let t = 0; t < tage; t++) { spalteVon.push(spalte); spalte += spuren[t]; }

  const spalten = ['58px'];
  for (let t = 0; t < tage; t++) {
    for (let i = 0; i < spuren[t]; i++) spalten.push((1 / spuren[t]).toFixed(4) + 'fr');
  }

  // Termine dieser Woche den Stunden zuordnen
  const termine = termineListe();
  const anStunde = new Map();
  const amTagOben = new Map();
  for (const e of termine) {
    const d = vonIso(e.datum);
    if (d < spWoche || d > ende) continue;
    if (e.eigener && e.von && e.bis && minuten(e.bis) > minuten(e.von)) continue;   // eigener Block
    const tag = Math.round((d - spWoche) / 86400000);
    const amTag = stunden.filter(s => s.datum === e.datum);

    // Erst über die Uhrzeit, dann über das Fach. Eine Hausübung hat keine
    // Uhrzeit, gehört aber trotzdem in ihre Stunde und nicht über den Tag.
    let ziel = null;
    if (e.von) {
      ziel = amTag.find(s => minuten(e.von) >= minuten(s.von) && minuten(e.von) < minuten(s.bis));
    }
    if (!ziel && e.fach) {
      const gesucht = String(e.fach).toLowerCase();
      ziel = amTag.find(s => (s.fach || '').toLowerCase() === gesucht)
          || amTag.find(s => (s.fachLang || '').toLowerCase() === gesucht);
    }

    if (ziel) {
      if (!anStunde.has(ziel.id)) anStunde.set(ziel.id, []);
      anStunde.get(ziel.id).push(e);
    } else {
      if (!amTagOben.has(tag)) amTagOben.set(tag, []);
      amTagOben.get(tag).push(e);
    }
  }

  const heute = heuteIso();
  // Was ersetzt wurde, wird durchgestrichen und das Neue danebengestellt - wie in WebUntis
  const ersetzt = (neu, alt) => (alt && alt !== neu)
    ? `<s>${esc(alt)}</s> ${esc(neu)}`
    : esc(neu || '');

  let html = `<div class="sp-grid" style="grid-template-columns:${spalten.join(' ')}">`;
  html += '<div></div>';
  for (let t = 0; t < tage; t++) {
    const d = new Date(spWoche.getFullYear(), spWoche.getMonth(), spWoche.getDate() + t);
    const iso = toIso(d);
    html += `<div class="sp-kopf${iso === heute ? ' heute' : ''}${iso < heute ? ' vergangen' : ''}" style="grid-column:${spalteVon[t]}/span ${spuren[t]}">
      <div class="wd">${WD[d.getDay()]}</div>${d.getDate()}.${d.getMonth() + 1}.
      ${(amTagOben.get(t) || []).map(e =>
        `<div class="sp-termin" style="--cat:${farbeVon(e.art)}">${esc(e.titel)}</div>`).join('')}
    </div>`;
  }

  // Zeilen aus dem Raster
  raster.forEach((r, i) => {
    html += `<div class="sp-zeit" style="grid-row:${i + 2}" data-von="${esc(r.von)}" data-bis="${esc(r.bis)}">${esc(r.von)}</div>`;
  });

  const zeileVon = t => {
    const m = minuten(t);
    for (let i = 0; i < raster.length; i++) {
      if (m >= minuten(raster[i].von) && m < minuten(raster[i].bis)) return i + 2;
    }
    for (let i = 0; i < raster.length; i++) if (m < minuten(raster[i].von)) return i + 2;
    return raster.length + 1;
  };
  const zeileBis = t => {
    const m = minuten(t);
    for (let i = raster.length - 1; i >= 0; i--) {
      if (m > minuten(raster[i].von)) return i + 3;
    }
    return 3;
  };

  for (let t = 0; t < tage; t++) {
    const datum = toIso(new Date(spWoche.getFullYear(), spWoche.getMonth(), spWoche.getDate() + t));
    const vorbei = datum < heute;

    for (const s of stunden.filter(x => x.datum === datum)) {
      const spur = lage.get('s' + s.id) || 0;
      const dran = anStunde.get(s.id) || [];
      const wichtig = dran.find(e => farbeVon(e.art) === '#e5484d') || dran[0];
      const notiz = notizZurStunde(s);
      const klassen = ['sp-stunde'];
      if (s.status === 'entfall' || s.status === 'cancelled') klassen.push('entfall');
      if (s.vertretung || (s.lehrerOrg && s.lehrerOrg !== s.lehrer)) klassen.push('vertretung');
      if (dran.some(e => farbeVon(e.art) === '#e5484d')) klassen.push('pruefung');
      if (dran.length) klassen.push('hat-termin');
      if (notiz) klassen.push('hat-notiz');
      if (vorbei) klassen.push('vergangen');

      html += `<div class="${klassen.join(' ')}" data-stunde="${esc(s.id)}"
          style="grid-column:${spalteVon[t] + spur}; grid-row:${zeileVon(s.von)}/${zeileBis(s.bis)}
                 ${wichtig ? `;--tcat:${farbeVon(wichtig.art)}` : ''}">
        <div class="f">${esc(s.fach || s.fachLang || '')}</div>
        <div class="n">${[ersetzt(s.raum, s.raumOrg), ersetzt(s.lehrer, s.lehrerOrg)].filter(Boolean).join(' · ')}</div>
        ${s.vertretung ? `<div class="n">${esc(s.vertretung)}</div>` : ''}
        ${dran.map(e => `<div class="sp-termin" style="--cat:${farbeVon(e.art)}">${esc(e.titel)}</div>`).join('')}
        ${notiz ? `<div class="sp-notiz">✎ ${esc(notiz.notiz)}</div>` : ''}
      </div>`;
    }

    for (const b of bloecke.filter(x => x.datum === datum)) {
      const spur = lage.get('b' + b.id) || 0;
      html += `<div class="sp-block${vorbei ? ' vergangen' : ''}" data-termin="${esc(b.id)}"
          style="grid-column:${spalteVon[t] + spur}; grid-row:${zeileVon(b.von)}/${zeileBis(b.bis)}; --cat:${farbeVon(b.art)}">
        <div class="f">${esc(b.titel)}</div>
        <div class="n">${esc(b.von)}–${esc(b.bis)}</div>
      </div>`;
    }
  }

  html += '</div>';
  $('#spGrid').innerHTML = html;

  $$('#spGrid [data-stunde]').forEach(el =>
    el.addEventListener('click', () => zeigeStunde(el.dataset.stunde)));
  $$('#spGrid [data-termin]').forEach(el =>
    el.addEventListener('click', () => zeigeTermin(el.dataset.termin)));

  const wochen = Object.keys((daten.stundenplan && daten.stundenplan.wochen) || {}).sort();
  $('#spHinweis').textContent = wochen.length
    ? `verfügbar: ${wochen[0]} bis ${wochen[wochen.length - 1]}`
    : '';

  zeichneJetztLinie();
}

/* Strich auf der aktuellen Uhrzeit - die Zeilen sind unterschiedlich hoch,
   deshalb wird die Lage aus den gezeichneten Zeilen berechnet. */
function zeichneJetztLinie() {
  const grid = document.querySelector('#spGrid .sp-grid');
  if (!grid) return;
  let linie = grid.querySelector('.sp-jetzt');
  const weg = () => { if (linie) linie.remove(); };

  const kopf = grid.querySelector('.sp-kopf.heute');
  const zeilen = Array.from(grid.querySelectorAll('.sp-zeit[data-von]'));
  if (!kopf || !zeilen.length || !zeilen[0].offsetHeight) return weg();

  const jetzt = new Date();
  const m = jetzt.getHours() * 60 + jetzt.getMinutes();
  let y = null;
  for (let i = 0; i < zeilen.length; i++) {
    const z = zeilen[i];
    const von = minuten(z.dataset.von), bis = minuten(z.dataset.bis);
    if (m >= von && m < bis) { y = z.offsetTop + (m - von) / Math.max(1, bis - von) * z.offsetHeight; break; }
    if (m < von) { if (i > 0) { const v = zeilen[i - 1]; y = (v.offsetTop + v.offsetHeight + z.offsetTop) / 2; } break; }
  }
  if (y === null) return weg();

  if (!linie) {
    linie = document.createElement('div');
    linie.className = 'sp-jetzt';
    linie.innerHTML = '<i class="sp-jetzt-heute"></i><span class="sp-jetzt-zeit"></span>';
    grid.appendChild(linie);
  }
  const erste = zeilen[0];
  linie.style.top = y + 'px';
  linie.style.left = erste.offsetLeft + 'px';
  linie.style.width = Math.max(0, grid.scrollWidth - erste.offsetLeft - 8) + 'px';
  linie.querySelector('.sp-jetzt-zeit').textContent = zweiStellig(jetzt.getHours()) + ':' + zweiStellig(jetzt.getMinutes());
  const heute = linie.querySelector('.sp-jetzt-heute');
  heute.style.left = (kopf.offsetLeft - erste.offsetLeft) + 'px';
  heute.style.width = kopf.offsetWidth + 'px';
}

/* ---------------- Kalender ---------------- */

function zeichneKalender() {
  if (!calMonat) calMonat = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const jahr = calMonat.getFullYear(), monat = calMonat.getMonth();
  $('#calMonat').textContent = `${MON[monat]} ${jahr}`;

  const erster = new Date(jahr, monat, 1);
  const start = new Date(erster);
  start.setDate(1 - ((erster.getDay() + 6) % 7));     // die Woche beginnt am Montag

  const nurWichtige = $('#fNurWichtige').checked;
  const proTag = new Map();
  for (const t of termineListe()) {
    if (nurWichtige && !t.wichtig) continue;
    if (!proTag.has(t.datum)) proTag.set(t.datum, []);
    proTag.get(t.datum).push(t);
  }

  const heute = heuteIso();
  let html = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map(d => `<div class="wd">${d}</div>`).join('');

  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const tagIso = toIso(d);
    const klassen = ['cal-zelle'];
    if (d.getMonth() !== monat) klassen.push('fremd');
    if (d.getDay() === 0 || d.getDay() === 6) klassen.push('wochenende');
    if (tagIso === heute) klassen.push('heute');
    if (tagIso === gewaehlterTag) klassen.push('gewaehlt');

    const liste = (proTag.get(tagIso) || [])
      .sort((a, b) => String(a.von || '').localeCompare(String(b.von || '')));
    const sichtbar = liste.slice(0, 3).map(t =>
      `<div class="cal-ev" style="--cat:${farbeVon(t.art)}${t.erledigt ? ';opacity:.45;text-decoration:line-through' : ''}">${esc(t.fach || t.titel)}</div>`).join('');
    const mehr = liste.length > 3 ? `<div class="cal-mehr">+${liste.length - 3} weitere</div>` : '';

    html += `<div class="${klassen.join(' ')}" data-tag="${tagIso}"><span class="n">${d.getDate()}</span>${sichtbar}${mehr}</div>`;
  }
  $('#calGrid').innerHTML = html;
  $$('#calGrid .cal-zelle').forEach(el => el.addEventListener('click', () => {
    gewaehlterTag = el.dataset.tag;
    zeichneKalender();
  }));
  zeichneTag();
}

function zeichneTag() {
  if (!gewaehlterTag) {
    $('#tagTitel').textContent = 'Tag auswählen';
    $('#tagListe').innerHTML = '<div class="leer">Klick im Kalender auf einen Tag.</div>';
    return;
  }
  $('#tagTitel').textContent = langesDatum(gewaehlterTag);
  const liste = termineListe()
    .filter(t => t.datum === gewaehlterTag)
    .sort((a, b) => String(a.von || '').localeCompare(String(b.von || '')));

  $('#tagListe').innerHTML = liste.length
    ? liste.map(t => `<div class="termin${t.erledigt ? ' erledigt' : ''}" style="--cat:${farbeVon(t.art)}" data-id="${esc(t.id)}">
        <div style="flex:1">
          <div class="titel">${esc(t.titel)}</div>
          <div class="unten">${esc(t.art)}${t.von ? ' · ' + esc(t.von) : ''}</div>
          ${t.notiz ? `<div class="notiz">${esc(t.notiz)}</div>` : ''}
        </div></div>`).join('')
    : '<div class="leer">Nichts an diesem Tag.</div>';

  $$('#tagListe .termin').forEach(el =>
    el.addEventListener('click', () => zeigeTermin(el.dataset.id)));
}

/* ---------------- Ansichten ---------------- */

function zeichneAlles() {
  zeichneTermine();
  zeichneKalender();
  if (spWoche) zeichneStundenplan();
}

function zeigeAnsicht(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'stundenplan') requestAnimationFrame(zeichneJetztLinie);
}

/* ---------------- Zugang ---------------- */

function ladeZugang() {
  try {
    zugang.repo  = localStorage.getItem('up.repo') || sessionStorage.getItem('up.repo') || '';
    zugang.token = localStorage.getItem('up.token') || sessionStorage.getItem('up.token') || '';
    $('#fMerken').checked = !sessionStorage.getItem('up.token');
  } catch (e) { /* privater Modus: dann eben ohne Merken */ }
  $('#fRepo').value = zugang.repo;
  $('#fToken').value = '';
  if (zugang.token) {
    $('#zugangStatus').innerHTML = '<div class="meldung gut">Token ist in diesem Browser hinterlegt.</div>';
  }
}

async function verbinden() {
  const repo = $('#fRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const token = $('#fToken').value.trim();
  if (!repo.includes('/')) { $('#zugangStatus').innerHTML = '<div class="meldung schlecht">Bitte als benutzer/repository eintragen.</div>'; return; }
  zugang.repo = repo;
  if (token) zugang.token = token;
  if (!zugang.token) { $('#zugangStatus').innerHTML = '<div class="meldung schlecht">Es fehlt noch das Token.</div>'; return; }
  // Merken heisst: bleibt auf dem Geraet. Sonst nur bis der Tab zugeht.
  try {
    const speicher = $('#fMerken').checked ? localStorage : sessionStorage;
    const anderer  = $('#fMerken').checked ? sessionStorage : localStorage;
    anderer.removeItem('up.repo'); anderer.removeItem('up.token');
    speicher.setItem('up.repo', zugang.repo);
    speicher.setItem('up.token', zugang.token);
  } catch (e) { /* ohne Merken weiter */ }
  $('#zugangStatus').innerHTML = '<div class="meldung">Verbinde …</div>';
  await ladeAlles(true);
  if (daten) {
    $('#zugangStatus').innerHTML = '<div class="meldung gut">Verbunden.</div>';
    $('#fToken').value = '';
    zeigeAnsicht('uebersicht');
  } else {
    $('#zugangStatus').innerHTML = '<div class="meldung schlecht">Das hat nicht geklappt – siehe Meldung unten rechts.</div>';
  }
}

function vergessen() {
  try {
    localStorage.removeItem('up.token');
    sessionStorage.removeItem('up.token');
  } catch (e) { /* egal */ }
  zugang.token = '';
  daten = null; nutzer = null;
  $('#fToken').value = '';
  $('#zugangStatus').innerHTML = '<div class="meldung">Token gelöscht. Diese Seite zeigt jetzt nichts mehr an.</div>';
  $('#terminListe').innerHTML = '';
  $('#spGrid').innerHTML = '';
  $('#calGrid').innerHTML = '';
  $('#tagListe').innerHTML = '';
  $('#kopfStand').textContent = 'kein Zugang';
}

/* ---------------- Start ---------------- */

function verdrahten() {
  $$('.tabs button').forEach(b => b.addEventListener('click', () => zeigeAnsicht(b.dataset.view)));
  $('#bVerbinden').addEventListener('click', verbinden);
  $('#bVergessen').addEventListener('click', vergessen);
  $('#bNeuladen').addEventListener('click', () => ladeAlles(false));
  $('#bNeu').addEventListener('click', zeigeNeuerTermin);
  $('#fErledigte').addEventListener('change', zeichneTermine);
  $('#fNurWichtige').addEventListener('change', () => { zeichneTermine(); zeichneKalender(); });
  $('#bMonatZurueck').addEventListener('click', () => { calMonat.setMonth(calMonat.getMonth() - 1); zeichneKalender(); });
  $('#bMonatVor').addEventListener('click', () => { calMonat.setMonth(calMonat.getMonth() + 1); zeichneKalender(); });
  $('#bHeute').addEventListener('click', () => { spWoche = montagVon(new Date()); zeichneStundenplan(); });
  $('#mZu').addEventListener('click', schliesseDialog);
  $('#mAbbruch').addEventListener('click', schliesseDialog);
  $('#mSpeichern').addEventListener('click', speichern);
  $('#mLoeschen').addEventListener('click', loeschen);
  $('#overlay').addEventListener('click', e => { if (e.target.id === 'overlay') schliesseDialog(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') schliesseDialog(); });

  $('#bWocheZurueck').addEventListener('click', () => { spWoche.setDate(spWoche.getDate() - 7); zeichneStundenplan(); });
  $('#bWocheVor').addEventListener('click', () => { spWoche.setDate(spWoche.getDate() + 7); zeichneStundenplan(); });

  // Die Jetzt-Linie wandert mit, auch wenn der Tab nicht im Vordergrund ist
  const takt = () => {
    if ($('#view-stundenplan').classList.contains('active')) zeichneJetztLinie();
    setTimeout(takt, Math.min(60000 - (Date.now() % 60000) + 150, 30000));
  };
  takt();
  window.addEventListener('resize', zeichneJetztLinie);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { zeichneJetztLinie(); ladeAlles(true); }
  });
}

gewaehlterTag = heuteIso();
calMonat = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
verdrahten();
ladeZugang();
if (zugang.repo && zugang.token) ladeAlles(true); else zeigeAnsicht('zugang');
