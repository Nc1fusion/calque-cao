// Calque CAO — inspection en vidéo : caméra en direct, placement des coins, accrochage, suivi, captures.
"use strict";
const $ = id => document.getElementById(id);
const video = $("video"), toile = $("toile"), ctx = toile.getContext("2d"), scene = $("scene");
const loupe = $("loupe"), lctx = loupe.getContext("2d");
const COUL = { cao: "#2ee08a", caoCache: "#2ee08a40", point: "#ffad33", mauvais: "#ff6b55", fantome: "#ffffffb0" };

const etat = {
  mode: "accueil",            // accueil | direct | placement | accrochage | suivi | photo
  source: null,               // camera | video | photo
  type: "h", D: {}, M: null, tol: 6,
  fw: 0, fh: 0, fige: null,   // taille de l'image source ; image figée (canvas)
  points: {}, sautes: new Set(), courant: 0, histo: [],
  pose: null, qualite: 0, faibles: 0, msSuivi: 0,
  vis: null,                  // tampon de profondeur pour l'affichage
  bilan: { captures: 0, mesures: [] },
  occupe: false, glisse: null, doigt: null, verrou: null,
};

// ---------- fil de calcul ----------
let travailleur = null, idMsg = 0;
const attentes = new Map();
function demarrerTravailleur() {
  travailleur = new Worker("js/travailleur.js");
  travailleur.onmessage = e => { const f = attentes.get(e.data.id); if (f) { attentes.delete(e.data.id); f(e.data); } };
  travailleur.onerror = e => bandeau("Erreur du calcul : " + (e.message || "inconnue"));
}
function envoyer(msg, transfert) {
  return new Promise(res => { const id = ++idMsg; attentes.set(id, res); travailleur.postMessage({ ...msg, id }, transfert || []); });
}

// ---------- modèle ----------
function lireDims() {
  const D = {};
  for (const [k, , v] of TYPES[etat.type].dims) { const el = $("d-" + k); const x = el ? parseFloat(el.value) : v; D[k] = x > 0 ? x : v; }
  return D;
}
function remplirReglages() {
  const T = TYPES[etat.type], z = $("dims"); z.innerHTML = "";
  T.dims.forEach(([k, lib, v]) => {
    const l = document.createElement("label"); l.htmlFor = "d-" + k;
    l.innerHTML = `${lib}<input id="d-${k}" type="number" inputmode="decimal" min="0.1" step="any" value="${etat.D[k] ?? v}">`;
    z.appendChild(l);
  });
  $("zone-trous").hidden = etat.type === "boite";
  document.querySelectorAll(".segments button").forEach(b => b.setAttribute("aria-pressed", b.dataset.type === etat.type));
}
async function appliquerModele() {
  etat.D = lireDims();
  etat.texteTrous = etat.type === "boite" ? "" : $("trous").value;
  etat.tol = parseFloat($("tol").value) || 6;
  etat.M = construireModele(etat.type, etat.D, etat.texteTrous);
  const err = $("trous-err");
  err.hidden = !etat.M.erreurs.length;
  err.textContent = etat.M.erreurs.length ? `Ligne(s) ${etat.M.erreurs.join(", ")} ignorée(s) : format non reconnu.` : "";
  $("b-piece").textContent = TYPES[etat.type].nom;
  viderBilan();
  await envoyer({ cmd: "modele", type: etat.type, D: etat.D, trous: etat.texteTrous });
  dessinerSchema();
}
$("b-piece").onclick = () => { remplirReglages(); $("reglages").showModal(); };
document.querySelectorAll(".segments button").forEach(b => b.onclick = () => {
  etat.type = b.dataset.type; etat.D = {}; remplirReglages(); $("trous").value = TYPES[etat.type].trous;
});
$("reglages").addEventListener("close", async () => {
  if ($("reglages").returnValue !== "ok") return;
  await appliquerModele();
  if (etat.pose) { etat.pose = null; if (etat.mode === "suivi") passerEn("direct"); }
  rafraichir();
});

// ---------- sources ----------
$("b-camera").onclick = async () => {
  if (!window.isSecureContext) { bandeau("La caméra n'est permise que sur une page sécurisée (https)."); return; }
  try {
    const flux = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    video.srcObject = flux; video.loop = false;
    await video.play();
    await new Promise(r => video.videoWidth ? r() : video.onloadedmetadata = r);
    etat.source = "camera"; preparerSource(video.videoWidth, video.videoHeight); passerEn("direct");
  } catch (e) {
    bandeau(e && e.name === "NotAllowedError" ? "Accès à la caméra refusé : autorise la caméra pour ce site dans les réglages du navigateur."
      : "Impossible d'ouvrir la caméra (" + (e && e.name || e) + ").");
  }
};
$("f-video").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  arreterCamera();
  const url = URL.createObjectURL(f);
  if (f.type.startsWith("image/")) {
    const im = new Image(); im.src = url; await im.decode();
    const s = Math.min(1, 2000 / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement("canvas");
    c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s);
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    etat.source = "photo"; preparerSource(c.width, c.height); etat.fige = c; viderPoints(); passerEn("placement");
    return;
  }
  video.srcObject = null; video.src = url; video.loop = true; video.muted = true;
  await new Promise(r => video.onloadedmetadata = r);
  await video.play().catch(() => {});
  etat.source = "video"; preparerSource(video.videoWidth, video.videoHeight); passerEn("direct");
});
function arreterCamera() { if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; } }
function preparerSource(w, h) {
  etat.fw = w; etat.fh = h; toile.width = w; toile.height = h;
  scene.classList.remove("vide"); etat.pose = null; etat.vis = null; viderPoints();
}

// image en niveaux de gris, réduite à maxCote, depuis la vidéo ou l'image figée
function gris(maxCote, depuis) {
  const src = depuis || (etat.mode === "placement" || etat.source === "photo" ? etat.fige : video);
  const s = Math.min(1, maxCote / Math.max(etat.fw, etat.fh));
  const w = Math.round(etat.fw * s), h = Math.round(etat.fh * s);
  const c = gris.c || (gris.c = document.createElement("canvas")); c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(src, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data, d = new Float32Array(w * h);
  for (let i = 0, j = 0; i < d.length; i++, j += 4) d[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
  return { w, h, data: d };
}
function figer() {
  const c = document.createElement("canvas"); c.width = etat.fw; c.height = etat.fh;
  c.getContext("2d").drawImage(video, 0, 0, etat.fw, etat.fh); return c;
}

// ---------- modes ----------
function passerEn(mode) {
  etat.mode = mode;
  scene.classList.toggle("fige", mode === "placement" || etat.source === "photo");
  $("coins-zone").hidden = mode !== "placement";
  if (etat.source === "video") { if (mode === "placement") video.pause(); else video.play().catch(() => {}); }
  if (mode === "suivi" || mode === "accrochage") garderEcranAllume(); else lacherEcran();
  etat.faibles = 0;
  commandes(); rafraichir();
}
function commandes() {
  const z = $("commandes"); z.innerHTML = "";
  const bouton = (txt, fn, cls = "", actif = true) => { const b = document.createElement("button"); b.textContent = txt; b.className = cls; b.disabled = !actif; b.onclick = fn; z.appendChild(b); return b; };
  const note = t => { const p = document.createElement("p"); p.className = "note"; p.textContent = t; z.appendChild(p); };
  const n = Object.keys(etat.points).length;
  switch (etat.mode) {
    case "direct":
      bouton("Figer l'image et placer les coins", () => { etat.fige = figer(); viderPoints(); passerEn("placement"); }, "principal");
      if (etat.pose) bouton("Raccrocher le modèle", () => passerEn("accrochage"));
      note("Cadre la pièce de biais (deux faces visibles), garde le téléphone immobile, puis fige l'image.");
      break;
    case "placement":
      if (etat.source === "photo") {
        bouton("Contrôler les trous", capturer, "principal", !!etat.pose && !etat.occupe);
      } else {
        bouton("Lancer le suivi", () => passerEn(etat.source === "camera" ? "accrochage" : "suivi"), "principal", !!etat.pose && !etat.occupe);
        bouton("Retour à la vidéo", () => passerEn("direct"));
      }
      bouton("Passer ce coin", passerCoin, "", etat.courant >= 0);
      bouton("Annuler", annulerCoin, "", etat.histo.length > 0);
      bouton("Tout effacer", () => { viderPoints(); etat.pose = null; commandes(); rafraichir(); });
      note(n < 4 ? `Touche au moins 4 coins (${n}/4), à peu près suffit. Garde le doigt appuyé pour viser avec la loupe.`
        : etat.occupe ? "Ajustement sur les arêtes…" : etat.pose ? `Modèle calé (contour aligné à ${Math.round(etat.qualite * 100)} %).` : "Calcul impossible : vérifie les numéros des coins.");
      break;
    case "accrochage":
      bouton("Annuler", () => passerEn("direct"));
      note("Remets la pièce sous le contour blanc en bougeant doucement le téléphone : le suivi démarre tout seul dès que ça colle.");
      break;
    case "suivi":
      bouton("Capturer et contrôler", capturer, "principal", !etat.occupeCapture);
      bouton("Arrêter le suivi", () => passerEn("direct"));
      note("Tourne lentement autour de la pièce et capture chaque face : le bilan regroupe tous les angles.");
      break;
  }
}

// ---------- coins ----------
function viderPoints() { etat.points = {}; etat.sautes = new Set(); etat.histo = []; etat.courant = 0; }
function prochainLibre(dep) { for (let i = 0; i < 8; i++) { const k = (dep + i) % 8; if (!(k in etat.points) && !etat.sautes.has(k)) return k; } return -1; }
function poser(k, xy) {
  etat.histo.push({ k, avant: etat.points[k] ? etat.points[k].slice() : null, sautait: etat.sautes.has(k) });
  etat.points[k] = xy; etat.sautes.delete(k); etat.courant = prochainLibre(k); placerModele();
}
function passerCoin() {
  if (etat.courant < 0) return;
  etat.histo.push({ k: etat.courant, avant: etat.points[etat.courant] || null, sautait: false });
  etat.sautes.add(etat.courant); delete etat.points[etat.courant]; etat.courant = prochainLibre(etat.courant); placerModele();
}
function annulerCoin() {
  const h = etat.histo.pop(); if (!h) return;
  if (h.avant) etat.points[h.k] = h.avant; else delete etat.points[h.k];
  if (h.sautait) etat.sautes.add(h.k); else etat.sautes.delete(h.k);
  etat.courant = h.k; placerModele();
}
async function placerModele() {
  const idx = Object.keys(etat.points).map(Number).sort((a, b) => a - b);
  etat.pose = null;
  if (idx.length < 4) { commandes(); rafraichir(); return; }
  const P3 = idx.map(i => etat.M.reperes[i]), P2 = idx.map(i => etat.points[i]);
  const d = calculerPose(P3, P2, etat.fw, etat.fh);
  if (d) etat.pose = { p: d.p };                     // aperçu immédiat
  etat.occupe = true; commandes(); rafraichir();
  const ticket = (placerModele.ticket = (placerModele.ticket || 0) + 1);
  const g = gris(1200, etat.fige);
  const r = await envoyer({ cmd: "demarrer", gris: g, P3, P2, wImg: etat.fw, hImg: etat.fh }, [g.data.buffer]);
  if (ticket !== placerModele.ticket) return;        // des coins ont changé entre-temps
  etat.occupe = false;
  if (!r.erreur) { etat.pose = { p: r.p }; etat.qualite = r.qualite; }
  etat.vis = null; commandes(); rafraichir();
}

// ---------- boucle vidéo ----------
let dernierEnvoi = 0;
async function boucle() {
  requestAnimationFrame(boucle);
  if (etat.mode === "suivi" || etat.mode === "accrochage" || etat.mode === "direct") rafraichir();
  if (etat.occupe || !etat.pose || !travailleur) return;
  const t = performance.now();
  if (etat.mode === "suivi") {
    if (video.readyState < 2) return;
    etat.occupe = true;
    const prec = etat.pose.p, avant = etat.posePrec || prec;
    const pred = prec.map((v, i) => i < 6 ? v + 0.5 * (v - avant[i]) : v);      // prédiction (vitesse constante, amortie)
    const g = gris(640, video);
    const r = await envoyer({ cmd: "suivre", gris: g, p: pred, wImg: etat.fw, hImg: etat.fh }, [g.data.buffer]);
    etat.occupe = false;
    if (etat.mode !== "suivi") return;
    etat.msSuivi = performance.now() - t; etat.qualite = r.qualite || 0;
    if (!r.erreur && !r.perdu && r.qualite >= 0.3) { etat.posePrec = prec; etat.pose = { p: r.p }; etat.faibles = 0; etat.vis = null; }
    else if (++etat.faibles >= 6) { etat.posePrec = null; passerEn("accrochage"); bandeau("Suivi perdu : replace la pièce sous le contour blanc."); }
  } else if (etat.mode === "accrochage" && t - dernierEnvoi > 250) {
    if (video.readyState < 2) return;
    dernierEnvoi = t; etat.occupe = true;
    const g = gris(800, video);
    const r = await envoyer({ cmd: "accrocher", gris: g, p: etat.pose.p, wImg: etat.fw, hImg: etat.fh }, [g.data.buffer]);
    etat.occupe = false;
    if (etat.mode !== "accrochage") return;
    etat.qualite = r.qualite || 0;
    if (!r.erreur && r.qualite >= 0.6) { etat.pose = { p: r.p }; etat.posePrec = null; etat.vis = null; passerEn("suivi"); }
  }
}

// ---------- captures et bilan ----------
async function capturer() {
  if (!etat.pose || etat.occupeCapture) return;
  etat.occupeCapture = true; commandes();
  // attendre que le suivi en cours libère le fil
  while (etat.occupe) await new Promise(r => setTimeout(r, 15));
  etat.occupe = true;
  const src = etat.source === "photo" ? etat.fige : figer();
  const g = gris(1280, src);
  const r = await envoyer({ cmd: "controler", gris: g, p: etat.pose.p, wImg: etat.fw, hImg: etat.fh, tol: etat.tol }, [g.data.buffer]);
  etat.occupe = false; etat.occupeCapture = false;
  if (r.erreur) { bandeau("Contrôle impossible : " + r.erreur); commandes(); return; }
  if (!r.trous) { bandeau("Capture ignorée : l'alignement n'est pas assez bon. Bouge moins vite ou rapproche-toi."); commandes(); return; }
  etat.bilan.captures++;
  r.trous.forEach((t, i) => { (etat.bilan.mesures[i] = etat.bilan.mesures[i] || []).push(t); });
  const nMauvais = r.trous.filter(t => t.etat === "decale" || t.etat === "absent").length;
  bandeau(`Capture ${etat.bilan.captures} : ${r.trous.filter(t => t.etat !== "cache").length} trou(s) vu(s), ${nMauvais} hors tolérance.`);
  afficherBilan(); commandes(); rafraichir();
}
function viderBilan() { etat.bilan = { captures: 0, mesures: [] }; afficherBilan(); }
$("b-vider").onclick = () => { viderBilan(); rafraichir(); };
function verdict(i) {
  // vote sur toutes les captures où le trou était visible
  const m = (etat.bilan.mesures[i] || []).filter(t => t.etat !== "cache");
  if (!m.length) return { etat: "nonvu", vues: 0 };
  const absents = m.filter(t => t.etat === "absent").length;
  if (absents > m.length / 2) return { etat: "absent", vues: m.length };
  const vus = m.filter(t => t.etat !== "absent"), decales = vus.filter(t => t.etat === "decale").length;
  const d = vus.map(t => t.decalage).sort((a, b) => a - b), med = d[d.length >> 1];
  return { etat: decales > vus.length / 2 ? "decale" : "ok", decalage: med, vues: m.length, accord: Math.max(decales, vus.length - decales) };
}
function afficherBilan() {
  const b = $("bilan"); b.hidden = !etat.M || !etat.M.trous.length || etat.bilan.captures === 0;
  if (b.hidden) return;
  $("nb-captures").textContent = etat.bilan.captures + " capture" + (etat.bilan.captures > 1 ? "s" : "");
  const V = etat.M.trous.map((_, i) => verdict(i)), c = e => V.filter(v => v.etat === e).length;
  $("compte").innerHTML = `<b>${c("ok")}</b> conformes · <b>${c("decale")}</b> décalés · <b>${c("absent")}</b> absents · <b>${c("nonvu")}</b> pas encore vus`;
  const ul = $("liste-trous"); ul.innerHTML = "";
  const ordre = { decale: 0, absent: 1, nonvu: 2, ok: 3 };
  etat.M.trous.map((tr, i) => ({ tr, v: V[i] })).sort((a, b) => ordre[a.v.etat] - ordre[b.v.etat]).forEach(({ tr, v }) => {
    const li = document.createElement("li"); li.className = v.etat;
    const vues = `${v.vues} vue${v.vues > 1 ? "s" : ""}`;
    const val = v.etat === "nonvu" ? "pas vu" : v.etat === "absent" ? `absent ? · ${vues}`
      : v.etat === "decale" ? `≈ ${v.decalage.toFixed(0)} mm · ${vues}` : `conforme · ${vues}`;
    li.innerHTML = `<span>${tr.nom}</span><span class="val">${val}</span>`;
    ul.appendChild(li);
  });
}

// ---------- dessin ----------
function bandeau(txt) { $("bandeau").textContent = txt; bandeau.t = performance.now(); }
function rafraichir() {
  if (!etat.fw) return;
  const fige = etat.mode === "placement" || etat.source === "photo";
  ctx.clearRect(0, 0, toile.width, toile.height);
  if (fige && etat.fige) ctx.drawImage(etat.fige, 0, 0);
  const ech = etat.fw / (toile.getBoundingClientRect().width || etat.fw);
  if (etat.pose && etat.M) {
    const fantome = etat.mode === "accrochage";
    tracerModele(etat.pose.p, fantome ? COUL.fantome : COUL.cao, fantome ? null : COUL.caoCache, Math.max(2, 2.4 * ech), !fantome);
  }
  if (fige) dessinerPoints(ech);
  // bandeau et indicateur
  if (performance.now() - (bandeau.t || 0) > 3500) {
    $("bandeau").innerHTML = etat.mode === "placement" ? (etat.courant >= 0 ? `Touche le coin <b>${etat.courant + 1}</b> · ${NOMS_REPERES[etat.courant]}` : "Coins traités. Touche un coin dans la liste pour le refaire.")
      : etat.mode === "accrochage" ? "Aligne la pièce sous le contour blanc"
      : etat.mode === "suivi" ? "Suivi en cours" : etat.mode === "direct" ? "Vidéo en direct" : "";
  }
  const es = $("etat-suivi");
  es.hidden = !(etat.mode === "suivi" || etat.mode === "accrochage");
  if (!es.hidden) {
    es.textContent = etat.mode === "suivi" ? `${Math.round(etat.qualite * 100)} % · ${Math.round(1000 / Math.max(1, etat.msSuivi))} im/s` : `accrochage… ${Math.round(etat.qualite * 100)} %`;
    es.className = "etat-suivi" + (etat.qualite < 0.45 ? " faible" : "") + (etat.faibles > 2 ? " perdu" : "");
  }
}
function visibilite(p) {
  // tampon de profondeur réduit, recalculé seulement quand la pose change
  if (etat.vis && etat.vis.p === p) return etat.vis;
  const s = Math.min(1, 360 / Math.max(etat.fw, etat.fh)), w = Math.round(etat.fw * s), h = Math.round(etat.fh * s);
  const pz = p.slice(); pz[6] += Math.log(s);
  etat.vis = { p, s, w, h, pz, zb: zbuffer(etat.M, pz, w / 2, h / 2, w, h) };
  return etat.vis;
}
function tracerModele(p, coul, coulCache, lw, avecTrous) {
  const M = etat.M, V = visibilite(p), cx = etat.fw / 2, cy = etat.fh / 2, ech = lw / 2.4;
  const pjv = projecteur(V.pz, V.w / 2, V.h / 2), pj = projecteur(p, cx, cy);
  const segment = (a, b, cv, cc, l, pointille) => {
    const qa = pj(a), qb = pj(b); if (qa[2] <= 1 || qb[2] <= 1) return;
    const n = Math.max(1, Math.ceil(Math.hypot(qb[0] - qa[0], qb[1] - qa[1]) / (10 * ech)));
    ctx.setLineDash(pointille ? [l * 2, l * 1.6] : []);
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n, tm = (t0 + t1) / 2, Pm = [0, 1, 2].map(i => a[i] + tm * (b[i] - a[i]));
      const v = estVisible(V.zb, V.w, V.h, pjv(Pm), 4);
      if (!v && !cc) continue;
      ctx.strokeStyle = v ? cv : cc; ctx.lineWidth = v ? l : l * 0.4;
      ctx.beginPath(); ctx.moveTo(qa[0] + t0 * (qb[0] - qa[0]), qa[1] + t0 * (qb[1] - qa[1])); ctx.lineTo(qa[0] + t1 * (qb[0] - qa[0]), qa[1] + t1 * (qb[1] - qa[1])); ctx.stroke();
    }
    ctx.setLineDash([]);
  };
  ctx.lineCap = "round";
  for (let e = 0; e < M.nbAretesContour; e++) segment(M.V[M.E[e][0]], M.V[M.E[e][1]], coul, coulCache, lw);
  if (!avecTrous) return;
  const R = rodrigues(p), t = p.slice(3, 6), cam = [0, 1, 2].map(i => -(R[i] * t[0] + R[3 + i] * t[1] + R[6 + i] * t[2]));
  M.trous.forEach((tr, i) => {
    const v = etat.bilan.captures ? verdict(i) : null, rouge = v && (v.etat === "decale" || v.etat === "absent");
    const rb = tr.rebords.find(r => ((cam[0] - r.centre[0]) * tr.axe[0] + (cam[1] - r.centre[1]) * tr.axe[1] + (cam[2] - r.centre[2]) * tr.axe[2]) * r.signe > 0) || tr.rebords[0];
    for (const e of rb.aretes) segment(M.V[M.E[e][0]], M.V[M.E[e][1]], rouge ? COUL.mauvais : coul, null, rouge ? lw * 1.3 : lw * 0.8, v && v.etat === "absent");
    if (v && v.etat === "decale") {
      const q = pj(tr.c); if (q[2] <= 1) return;
      ctx.font = `700 ${Math.round(14 * ech)}px ui-monospace, monospace`; ctx.lineWidth = 3 * ech; ctx.strokeStyle = "#000"; ctx.fillStyle = COUL.mauvais;
      const txt = Math.round(v.decalage) + " mm"; ctx.strokeText(txt, q[0] + 14 * ech, q[1] - 10 * ech); ctx.fillText(txt, q[0] + 14 * ech, q[1] - 10 * ech);
    }
  });
}
function dessinerPoints(ech) {
  const r = Math.max(5, 7 * ech);
  ctx.font = `700 ${Math.round(13 * ech)}px ui-monospace, monospace`;
  for (const k in etat.points) {
    const [x, y] = etat.points[k];
    ctx.fillStyle = COUL.point; ctx.strokeStyle = "#000a"; ctx.lineWidth = Math.max(1, ech);
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 3 * ech;
    ctx.strokeText(+k + 1, x + r + 3 * ech, y - r); ctx.fillText(+k + 1, x + r + 3 * ech, y - r);
  }
  dessinerCoins();
}
function dessinerCoins() {
  const z = $("coins"); if ($("coins-zone").hidden) return; z.innerHTML = "";
  NOMS_REPERES.forEach((nom, k) => {
    const b = document.createElement("button");
    b.className = "coin" + (k in etat.points ? " fait" : "") + (etat.sautes.has(k) ? " saute" : "") + (k === etat.courant ? " courant" : "");
    b.innerHTML = `<span class="num">${k + 1}</span><span>${nom}</span>`;
    b.onclick = () => { etat.courant = k; etat.sautes.delete(k); rafraichir(); dessinerSchema(); };
    z.appendChild(b);
  });
  dessinerSchema();
}
function dessinerSchema() {
  const c = $("schema"), g = c.getContext("2d"), W = c.width, H = c.height, M = etat.M;
  g.clearRect(0, 0, W, H); if (!M) return;
  const R = M.reperes, mn = i => Math.min(...R.map(r => r[i])), mx = i => Math.max(...R.map(r => r[i]));
  const ctr = [0, 1, 2].map(i => (mn(i) + mx(i)) / 2), S = Math.max(...[0, 1, 2].map(i => mx(i) - mn(i)));
  const oeil = [ctr[0] - 0.75 * S, ctr[1] - 1.5 * S, ctr[2] + 1.1 * S];
  const av = norm3([0, 1, 2].map(i => ctr[i] - oeil[i])), dr = norm3(cross3(av, [0, 0, 1])), bas = cross3(av, dr);
  const pr0 = P => { const d = [0, 1, 2].map(i => P[i] - oeil[i]), z = d[0] * av[0] + d[1] * av[1] + d[2] * av[2]; return [(d[0] * dr[0] + d[1] * dr[1] + d[2] * dr[2]) / z, (d[0] * bas[0] + d[1] * bas[1] + d[2] * bas[2]) / z]; };
  const pts = R.map(pr0), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const k = Math.min((W - 44) / (Math.max(...xs) - Math.min(...xs)), (H - 44) / (Math.max(...ys) - Math.min(...ys)));
  const ox = (W - k * (Math.max(...xs) + Math.min(...xs))) / 2, oy = (H - k * (Math.max(...ys) + Math.min(...ys))) / 2;
  const pr = P => { const q = pr0(P); return [ox + k * q[0], oy + k * q[1]]; };
  g.lineWidth = 1.5; g.strokeStyle = "#9aa7a0";
  for (let e = 0; e < M.nbAretesContour; e++) { const a = pr(M.V[M.E[e][0]]), b = pr(M.V[M.E[e][1]]); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); }
  g.font = "700 20px ui-monospace, monospace";
  R.forEach((P, i) => {
    const p = pr(P), actif = i === etat.courant, fait = i in etat.points;
    g.fillStyle = actif ? COUL.cao : fait ? COUL.point : "#e7ece9";
    g.beginPath(); g.arc(p[0], p[1], actif ? 8 : 5, 0, 7); g.fill(); g.fillText(i + 1, p[0] + 7, p[1] - 7);
  });
}

// ---------- toucher, loupe (mode placement) ----------
function versImage(e) {
  const r = toile.getBoundingClientRect();
  return [(e.clientX - r.left) * etat.fw / r.width, (e.clientY - r.top) * etat.fh / r.height, e.clientX - r.left, e.clientY - r.top];
}
function montrerLoupe(xy) {
  const [x, y, cx, cy] = xy, r = toile.getBoundingClientRect(), ech = etat.fw / r.width, zone = 22 * ech;
  lctx.clearRect(0, 0, 264, 264); lctx.save(); lctx.beginPath(); lctx.arc(132, 132, 132, 0, 7); lctx.clip();
  lctx.imageSmoothingEnabled = false; lctx.drawImage(toile, x - zone, y - zone, zone * 2, zone * 2, 0, 0, 264, 264); lctx.restore();
  lctx.strokeStyle = COUL.point; lctx.lineWidth = 2;
  lctx.beginPath(); lctx.moveTo(132, 112); lctx.lineTo(132, 152); lctx.moveTo(112, 132); lctx.lineTo(152, 132); lctx.stroke();
  let lx = cx - 66, ly = cy - 166; if (ly < 4) ly = cy + 40; lx = Math.max(4, Math.min(r.width - 136, lx));
  loupe.style.left = lx + "px"; loupe.style.top = ly + "px"; loupe.hidden = false;
}
toile.addEventListener("pointerdown", e => {
  if (etat.mode !== "placement") return;
  e.preventDefault(); toile.setPointerCapture(e.pointerId);
  const xy = versImage(e), seuil = 26 * etat.fw / toile.getBoundingClientRect().width;
  let pris = null, dmin = seuil;
  for (const k in etat.points) { const d = Math.hypot(etat.points[k][0] - xy[0], etat.points[k][1] - xy[1]); if (d < dmin) { dmin = d; pris = +k; } }
  etat.glisse = pris !== null ? { k: pris, avant: etat.points[pris].slice() } : (etat.courant >= 0 ? { k: etat.courant, nouveau: true } : null);
  etat.doigt = xy;
  if (etat.glisse && !etat.glisse.nouveau) { etat.points[pris] = [xy[0], xy[1]]; rafraichir(); }
  montrerLoupe(xy);
});
toile.addEventListener("pointermove", e => {
  if (!etat.doigt) return;
  const xy = versImage(e); etat.doigt = xy;
  if (etat.glisse && !etat.glisse.nouveau) { etat.points[etat.glisse.k] = [xy[0], xy[1]]; rafraichir(); }
  montrerLoupe(xy);
});
function finDoigt(annule) {
  loupe.hidden = true;
  const g = etat.glisse, xy = etat.doigt; etat.glisse = null; etat.doigt = null;
  if (!g || !xy) return;
  const p = [Math.max(0, Math.min(etat.fw, xy[0])), Math.max(0, Math.min(etat.fh, xy[1]))];
  if (annule) { if (!g.nouveau) etat.points[g.k] = g.avant; rafraichir(); return; }
  if (g.nouveau) poser(g.k, p); else { etat.histo.push({ k: g.k, avant: g.avant, sautait: false }); etat.points[g.k] = p; placerModele(); }
}
toile.addEventListener("pointerup", () => finDoigt(false));
toile.addEventListener("pointercancel", () => finDoigt(true));
window.addEventListener("resize", rafraichir);

// ---------- écran allumé pendant le suivi ----------
async function garderEcranAllume() { try { if (!etat.verrou && navigator.wakeLock) etat.verrou = await navigator.wakeLock.request("screen"); } catch (e) { /* facultatif */ } }
function lacherEcran() { if (etat.verrou) { etat.verrou.release().catch(() => {}); etat.verrou = null; } }

// ---------- démarrage ----------
(async function init() {
  scene.classList.add("vide");
  demarrerTravailleur();
  $("trous").value = TYPES[etat.type].trous;
  remplirReglages();
  await appliquerModele();
  commandes();
  requestAnimationFrame(boucle);
})();
