// ---- Placement automatique : trouver la pièce dans l'image sans toucher de coins ----
// 1. carte des distances aux arêtes de l'image (transformée de distance) ;
// 2. on essaie des centaines de points de vue du modèle (direction, rotation, taille, position) ;
//    chaque essai est noté par la distance moyenne entre ses arêtes et celles de l'image ;
// 3. les meilleurs essais sont affinés par le recalage habituel ; on garde le mieux aligné.
function transformeeDistance(G, tronque) {
  // 4 cartes de distance, une par orientation d'arête (0°, 45°, 90°, 135°) : une arête du modèle
  // ne peut « coller » qu'à une arête de l'image qui a à peu près la même direction.
  const { w, h, gx, gy, seuil } = G, cartes = [];
  for (let k = 0; k < 4; k++) cartes.push(new Float32Array(w * h).fill(1e6));
  for (let i = 0; i < w * h; i++) {
    const m = Math.hypot(gx[i], gy[i]); if (m <= seuil * 1.4) continue;
    let a = Math.atan2(gy[i], gx[i]) * 180 / Math.PI; a = ((a % 180) + 180) % 180;      // direction du gradient (normale à l'arête)
    const k0 = Math.floor(a / 45) % 4, k1 = (k0 + 1) % 4;
    cartes[k0][i] = 0; cartes[k1][i] = 0;                                                 // deux classes voisines (tolérance ±45°)
  }
  for (const D of cartes) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; let d = D[i];
      if (x > 0) d = Math.min(d, D[i - 1] + 3);
      if (y > 0) { d = Math.min(d, D[i - w] + 3); if (x > 0) d = Math.min(d, D[i - w - 1] + 4); if (x < w - 1) d = Math.min(d, D[i - w + 1] + 4); }
      D[i] = d;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x; let d = D[i];
      if (x < w - 1) d = Math.min(d, D[i + 1] + 3);
      if (y < h - 1) { d = Math.min(d, D[i + w] + 3); if (x < w - 1) d = Math.min(d, D[i + w + 1] + 4); if (x > 0) d = Math.min(d, D[i + w - 1] + 4); }
      D[i] = d;
    }
    for (let i = 0; i < w * h; i++) D[i] = Math.min(D[i] / 3, tronque);
  }
  // liste des pixels d'arête (pour le score inverse : arêtes de l'image non expliquées par le modèle)
  const liste = [];
  for (let i = 0; i < w * h; i++) if (Math.hypot(gx[i], gy[i]) > seuil * 1.4) liste.push(i % w, (i / w) | 0);
  cartes.pixels = new Int16Array(liste);
  return cartes;
}
// score inverse : distance moyenne des arêtes de l'image (dans le cadre de la pièce) au modèle le plus proche
function noteInverse(D, pts, ux, uy, roll, s, tronque) {
  const c = Math.cos(roll) * s, sn = Math.sin(roll) * s, n = pts.length / 3, X = new Float32Array(n), Y = new Float32Array(n);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let k = 0; k < n; k++) {
    X[k] = ux + c * pts[3 * k] - sn * pts[3 * k + 1]; Y[k] = uy + sn * pts[3 * k] + c * pts[3 * k + 1];
    x0 = Math.min(x0, X[k]); x1 = Math.max(x1, X[k]); y0 = Math.min(y0, Y[k]); y1 = Math.max(y1, Y[k]);
  }
  const px = D.pixels; let somme = 0, m = 0;
  for (let i = 0; i < px.length; i += 2) {
    const x = px[i], y = px[i + 1]; if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    if ((m++ & 1)) continue;                                   // un pixel sur deux suffit
    let d = tronque * tronque;
    for (let k = 0; k < n; k++) { const dx = X[k] - x, dy = Y[k] - y, q = dx * dx + dy * dy; if (q < d) d = q; }
    somme += Math.sqrt(d);
  }
  const vus = Math.ceil(m / 2);
  return vus ? somme / vus : tronque;
}
function poseRegarder(oeil, cible, haut, f) {
  const av = norm3([0, 1, 2].map(i => cible[i] - oeil[i]));
  let dr = cross3(av, haut); if (Math.hypot(...dr) < 1e-6) dr = cross3(av, [1, 0, 0]);
  dr = norm3(dr); const bas = cross3(av, dr);
  const R = [...dr, ...bas, ...av];
  return [...versRvec(R), ...[0, 1, 2].map(i => -(R[3 * i] * oeil[0] + R[3 * i + 1] * oeil[1] + R[3 * i + 2] * oeil[2])), Math.log(f)];
}
// points (relatifs au centre de l'image) le long des arêtes visibles, pour une vue donnée
function echantillonsVue(M, p, cx, cy, w, h, nbMax, avecTrous) {
  const zb = zbuffer(M, p, cx, cy, w, h), pj = projecteur(p, cx, cy), pts = [];
  const nbAr = avecTrous ? M.E.length : M.nbAretesContour;
  let total = 0; const lg = [];
  for (let e = 0; e < nbAr; e++) { const a = pj(M.V[M.E[e][0]]), b = pj(M.V[M.E[e][1]]); lg.push(Math.hypot(b[0] - a[0], b[1] - a[1])); total += lg[e]; }
  const pas = Math.max(1, total / (nbMax * 1.6));
  for (let e = 0; e < nbAr; e++) {
    const n = Math.floor(lg[e] / pas); if (n < 1) continue;
    const A = M.V[M.E[e][0]], B = M.V[M.E[e][1]];
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, P = [0, 1, 2].map(i => A[i] + t * (B[i] - A[i])), q = pj(P);
      if (estVisible(zb, w, h, q, 3)) {
        const qa = pj(A), qb = pj(B);
        const ang = Math.atan2(qb[0] - qa[0], -(qb[1] - qa[1])) * 180 / Math.PI;   // normale de l'arête à l'écran
        pts.push(q[0] - cx, q[1] - cy, ang);
      }
    }
  }
  // sous-échantillonnage régulier
  const n = pts.length / 3;
  if (n <= nbMax) return new Float32Array(pts);
  const out = new Float32Array(nbMax * 3);
  for (let k = 0; k < nbMax; k++) { const j = Math.floor(k * n / nbMax); out[3 * k] = pts[3 * j]; out[3 * k + 1] = pts[3 * j + 1]; out[3 * k + 2] = pts[3 * j + 2]; }
  return out;
}
function noteChanfrein(D, w, h, pts, ux, uy, roll, s, tronque) {
  const c = Math.cos(roll) * s, sn = Math.sin(roll) * s, rd = roll * 180 / Math.PI; let somme = 0;
  for (let k = 0; k < pts.length; k += 3) {
    const x = (ux + c * pts[k] - sn * pts[k + 1]) | 0, y = (uy + sn * pts[k] + c * pts[k + 1]) | 0;
    let a = (pts[k + 2] + rd) % 180; if (a < 0) a += 180;
    const carte = D[Math.round(a / 45) % 4];
    somme += (x < 0 || y < 0 || x >= w || y >= h) ? tronque : carte[y * w + x];
  }
  return somme / (pts.length / 3);
}
// gris : image de travail ; renvoie une liste de poses candidates triées (pose en pixels de cette image)
function placerAuto(gris, M, options = {}) {
  const t0 = Date.now();
  // image de recherche réduite (~320 px)
  const sr = Math.min(1, 320 / Math.max(gris.w, gris.h));
  const petit = sr < 1 ? reduire(gris, sr) : gris;
  const w = petit.w, h = petit.h, cx = w / 2, cy = h / 2, f = 26 / 36 * Math.max(w, h);
  const Gs = preparerNiveau(petit, 1.0), tronque = 12, D = transformeeDistance(Gs, tronque);
  const mn = M.boite ? M.boite[0] : [0, 1, 2].map(i => Math.min(...M.V.map(p => p[i]))), mx = M.boite ? M.boite[1] : [0, 1, 2].map(i => Math.max(...M.V.map(p => p[i])));
  const c3 = [0, 1, 2].map(i => (mn[i] + mx[i]) / 2), S = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
  const D0 = f * S / (0.6 * Math.min(w, h));
  // 1. recherche grossière
  const vues = [];
  for (let el = -60; el <= 60; el += 30) for (let az = 0; az < 360; az += 30) vues.push([az, el]);
  vues.push([0, 85], [0, -85]);
  const cand = [];
  const garder = (o) => {
    cand.push(o); if (cand.length > 4000) { cand.sort((a, b) => a.note - b.note); cand.length = 2000; }
  };
  for (const [az, el] of vues) {
    const a = az * Math.PI / 180, e = el * Math.PI / 180, dir = [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
    const p = poseRegarder(c3.map((v, i) => v + D0 * dir[i]), c3, [0, 0, 1], f);
    const pts = echantillonsVue(M, p, cx, cy, w, h, 60, false);
    if (pts.length < 60) continue;
    // étendue de la pièce à l'écran pour cette vue : on écarte les vues où elle paraîtrait minuscule ou débordante
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let k = 0; k < pts.length; k += 3) { x0 = Math.min(x0, pts[k]); x1 = Math.max(x1, pts[k]); y0 = Math.min(y0, pts[k + 1]); y1 = Math.max(y1, pts[k + 1]); }
    const etendue = Math.max(x1 - x0, y1 - y0);
    for (let roll = 0; roll < 360; roll += 30) for (const s of [0.6, 0.8, 1.05, 1.35, 1.75]) {
      if (s * etendue < 0.4 * Math.min(w, h) || s * etendue > 1.05 * Math.max(w, h)) continue;
      const r = roll * Math.PI / 180;
      for (let uy = 0.15 * h; uy < 0.85 * h; uy += 12) for (let ux = 0.15 * w; ux < 0.85 * w; ux += 12) {
        const note = noteChanfrein(D, w, h, pts, ux, uy, r, s, tronque);
        if (note < tronque * 0.45) garder({ note, az, el, roll, s, ux, uy, p });
      }
    }
  }
  cand.sort((a, b) => a.note - b.note);
  // 2. affinage local des meilleurs (sur la petite image), en évitant les doublons
  // diversité : au plus 2 hypothèses par direction de vue
  const retenus = [], parVue = {};
  for (const c of cand) {
    if (retenus.length >= 16) break;
    const kv = c.az + "/" + c.el; if ((parVue[kv] || 0) >= 2) continue;
    if (retenus.some(o => o.az === c.az && o.el === c.el && Math.abs(o.roll - c.roll) < 45 && Math.hypot(o.ux - c.ux, o.uy - c.uy) < 40)) continue;
    parVue[kv] = (parVue[kv] || 0) + 1;
    const pts = echantillonsVue(M, c.p, cx, cy, w, h, 120, false);
    const noter = o => noteChanfrein(D, w, h, pts, o.ux, o.uy, o.roll * Math.PI / 180, o.s, tronque);
    let b = { ...c, note: noter(c) };
    for (let pas of [8, 4, 2]) for (let it = 0; it < 3; it++) {
      let mieux = false;
      for (const [dx, dy, dr, ds] of [[pas, 0, 0, 1], [-pas, 0, 0, 1], [0, pas, 0, 1], [0, -pas, 0, 1], [0, 0, pas, 1], [0, 0, -pas, 1], [0, 0, 0, 1 + pas / 60], [0, 0, 0, 1 - pas / 60]]) {
        const o = { ...b, ux: b.ux + dx, uy: b.uy + dy, roll: b.roll + dr, s: b.s * ds };
        o.note = noter(o);
        if (o.note < b.note) { b = o; mieux = true; }
      }
      if (!mieux) break;
    }
    retenus.push(b);
  }
  // 3. conversion en pose 3D, puis recalage sur l'image de travail
  const sg = gris.w / w;
  const res = retenus.map(c => {
    const p = c.p, R0 = rodrigues(p), r = c.roll * Math.PI / 180, cr = Math.cos(r), srr = Math.sin(r);
    const Rz = [cr, -srr, 0, srr, cr, 0, 0, 0, 1];
    const R = [0, 1, 2].flatMap(i => [0, 1, 2].map(j => Rz[3 * i] * R0[j] + Rz[3 * i + 1] * R0[3 + j] + Rz[3 * i + 2] * R0[6 + j]));
    // centre de l'objet : profondeur D0/s, à la position (ux, uy) de l'image réduite
    const Z = D0 / c.s, X = (c.ux - cx) * Z / f, Y = (c.uy - cy) * Z / f;
    // le centre de la vue (cible) projetait au centre de l'image ; la boîte englobante est centrée sur c3
    const Rc = [0, 1, 2].map(i => R[3 * i] * c3[0] + R[3 * i + 1] * c3[1] + R[3 * i + 2] * c3[2]);
    const pg = [...versRvec(R), X - Rc[0], Y - Rc[1], Z - Rc[2], Math.log(f * sg)];
    return { p: pg, note: c.note };
  });
  const fini = [];
  for (const c of res.slice(0, options.nbAffiner || 10)) {
    const a = accrocherPose(gris, M, c.p, gris.w / 2, gris.h / 2);
    const pjf = projecteur(a.p, gris.w / 2, gris.h / 2), xs = M.reperes.map(P => pjf(P));
    const taille = Math.max(Math.max(...xs.map(q => q[0])) - Math.min(...xs.map(q => q[0])), Math.max(...xs.map(q => q[1])) - Math.min(...xs.map(q => q[1])));
    if (taille < 0.35 * Math.min(gris.w, gris.h)) continue;                 // trop petit : faux accrochage
    const qt = qualiteTrous(gris, M, a.p, gris.w / 2, gris.h / 2);
    fini.push({ p: a.p, qualite: a.qualite, qualiteTrous: qt, note: a.qualite + qt });
  }
  fini.sort((a, b) => b.note - a.note);
  return { candidats: fini, ms: Date.now() - t0 };
}
function reduire(g, s) {
  const w = Math.max(1, Math.round(g.w * s)), h = Math.max(1, Math.round(g.h * s)), d = new Float32Array(w * h);
  const k = 1 / s;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0, n = 0;
    const x0 = Math.floor(x * k), x1 = Math.min(g.w, Math.floor((x + 1) * k)), y0 = Math.floor(y * k), y1 = Math.min(g.h, Math.floor((y + 1) * k));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { a += g.data[yy * g.w + xx]; n++; }
    d[y * w + x] = n ? a / n : 0;
  }
  return { w, h, data: d };
}
// part des rebords de trous visibles qui tombent sur une arête (sert à départager les positions symétriques)
function qualiteTrous(gris, M, p, cx, cy) {
  if (!M.trous.length) return 0;
  const G = preparerNiveau(gris, 0.8 * Math.min(gris.w, gris.h) / 1000 + 0.6), zb = zbuffer(M, p, cx, cy, G.w, G.h);
  const liste = Array.from({ length: M.E.length - M.nbAretesContour }, (_, i) => M.nbAretesContour + i);
  const pts = mesurer(G, M, p, cx, cy, 3, 3, zb, liste).filter(o => o.vis);
  return pts.length ? pts.filter(o => o.ok && Math.abs(o.d) <= 2).length / pts.length : 0;
}
if (typeof module !== "undefined") module.exports = { placerAuto, transformeeDistance, poseRegarder };
