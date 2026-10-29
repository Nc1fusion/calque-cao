// ---- Solveur de pose (PnP) maison : Levenberg-Marquardt, plusieurs départs ----
function rodrigues(r) {
  const th = Math.hypot(r[0], r[1], r[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const k = [r[0] / th, r[1] / th, r[2] / th], c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  return [
    c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s,
    k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s,
    k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v,
  ];
}
function versRvec(R) {   // matrice -> vecteur de rotation
  const tr = R[0] + R[4] + R[8], th = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  if (th < 1e-9) return [0, 0, 0];
  if (Math.PI - th < 1e-6) {
    const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2)), y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)) * (R[1] >= 0 ? 1 : -1),
      z = Math.sqrt(Math.max(0, (R[8] + 1) / 2)) * (R[2] >= 0 ? 1 : -1);
    return [x * th, y * th, z * th];
  }
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}
function eulerR(a, b, c) {  // Rz(c) Ry(b) Rx(a)
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  return [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa,
    sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa,
    -sb, cb * sa, cb * ca];
}
function projeter(P, p, cx, cy) { // p = [rx,ry,rz,tx,ty,tz,logf]
  const R = rodrigues(p), f = Math.exp(p[6]);
  const x = R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + p[3];
  const y = R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + p[4];
  const z = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + p[5];
  return [f * x / z + cx, f * y / z + cy, z];
}
function residus(p, P3, P2, cx, cy) {
  const r = [];
  for (let i = 0; i < P3.length; i++) {
    const q = projeter(P3[i], p, cx, cy);
    if (q[2] <= 1) { r.push(1e4, 1e4); continue; }   // derrière la caméra : très pénalisé
    r.push(q[0] - P2[i][0], q[1] - P2[i][1]);
  }
  return r;
}
function resoudreLin(A, b) { // Gauss avec pivot
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let m = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[m][c])) m = r;
    [M[c], M[m]] = [M[m], M[c]];
    if (Math.abs(M[c][c]) < 1e-15) return null;
    for (let r = 0; r < n; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}
function lm(p0, libres, P3, P2, cx, cy, iters) {
  let p = p0.slice(), r = residus(p, P3, P2, cx, cy), cout = r.reduce((s, v) => s + v * v, 0), lam = 1e-3;
  for (let it = 0; it < iters; it++) {
    const J = libres.map(k => {
      const q = p.slice(), h = k < 3 ? 1e-6 : (k < 6 ? 1e-4 * Math.max(1, Math.abs(p[k])) : 1e-6);
      q[k] += h; const rq = residus(q, P3, P2, cx, cy); return rq.map((v, i) => (v - r[i]) / h);
    });
    const n = libres.length, A = [], g = [];
    for (let a = 0; a < n; a++) {
      A.push([]); g.push(-J[a].reduce((s, v, i) => s + v * r[i], 0));
      for (let b = 0; b < n; b++) A[a].push(J[a].reduce((s, v, i) => s + v * J[b][i], 0));
    }
    let ameliore = false;
    for (let essai = 0; essai < 8; essai++) {
      const Ad = A.map((row, i) => row.map((v, j) => i === j ? v * (1 + lam) + 1e-9 : v));
      const d = resoudreLin(Ad, g); if (!d) { lam *= 10; continue; }
      const q = p.slice(); libres.forEach((k, i) => q[k] += d[i]);
      const rq = residus(q, P3, P2, cx, cy), cq = rq.reduce((s, v) => s + v * v, 0);
      if (cq < cout) { p = q; r = rq; const delta = cout - cq; cout = cq; lam = Math.max(lam / 5, 1e-9); ameliore = delta > 1e-10 * cout; break; }
      lam *= 10;
    }
    if (!ameliore) break;
  }
  return { p, cout };
}

// P3 : points 3D (mm), P2 : points image (px), w,h : taille image
function calculerPose(P3, P2, w, h, facteurFocale = 1) {
  const cx = w / 2, cy = h / 2, f0 = facteurFocale * 26 / 36 * Math.max(w, h);
  const libreFocale = P3.length >= 6;
  // centre et taille, pour placer l'objet à une distance plausible
  const c3 = [0, 1, 2].map(k => P3.reduce((s, P) => s + P[k], 0) / P3.length);
  const c2 = [0, 1].map(k => P2.reduce((s, P) => s + P[k], 0) / P2.length);
  const t3 = Math.sqrt(P3.reduce((s, P) => s + (P[0] - c3[0]) ** 2 + (P[1] - c3[1]) ** 2 + (P[2] - c3[2]) ** 2, 0) / P3.length);
  const t2 = Math.sqrt(P2.reduce((s, P) => s + (P[0] - c2[0]) ** 2 + (P[1] - c2[1]) ** 2, 0) / P2.length) || 1;
  const dist = f0 * t3 / t2;
  const ray = [(c2[0] - cx) / f0, (c2[1] - cy) / f0, 1];
  let meilleur = null; const sols = [];
  const pas = Math.PI / 4;
  for (let a = 0; a < 8; a++) for (let b = -2; b <= 2; b++) for (let c = 0; c < 8; c++) {
    const R = eulerR(a * pas, b * pas, c * pas);
    const Rc = [R[0] * c3[0] + R[1] * c3[1] + R[2] * c3[2], R[3] * c3[0] + R[4] * c3[1] + R[5] * c3[2], R[6] * c3[0] + R[7] * c3[1] + R[8] * c3[2]];
    const p0 = [...versRvec(R), ray[0] * dist - Rc[0], ray[1] * dist - Rc[1], dist - Rc[2], Math.log(f0)];
    let s = lm(p0, [0, 1, 2, 3, 4, 5], P3, P2, cx, cy, 25);
    if (meilleur && s.cout > meilleur.cout * 50) continue;
    s = lm(s.p, libreFocale ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5], P3, P2, cx, cy, 60);
    sols.push(s);
    if (!meilleur || s.cout < meilleur.cout) meilleur = s;
  }
  if (!meilleur) return null;
  const emballer = s => { const p = s.p; return { p, f: Math.exp(p[6]), cx, cy, erreur: Math.sqrt(s.cout / P3.length), distance: Math.hypot(p[3], p[4], p[5]) }; };
  const p = meilleur.p;
  const f = Math.exp(p[6]);
  if (libreFocale && (f < 0.3 * Math.max(w, h) || f > 3 * Math.max(w, h))) return null;
  // autres solutions plausibles (ex. pièce vue « à l'envers » quand les repères sont presque dans un plan)
  const res = emballer(meilleur), alt = [];
  sols.sort((a, b) => a.cout - b.cout);
  for (const s of sols) {
    const e = Math.sqrt(s.cout / P3.length);
    if (e > 3 * res.erreur + 15) break;
    const R1 = rodrigues(s.p);
    const distincte = [res, ...alt].every(o => { const R0 = rodrigues(o.p); const tr = R0[0] * R1[0] + R0[1] * R1[1] + R0[2] * R1[2] + R0[3] * R1[3] + R0[4] * R1[4] + R0[5] * R1[5] + R0[6] * R1[6] + R0[7] * R1[7] + R0[8] * R1[8]; return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) > 0.17; });
    if (distincte && s.p[5] > 0) alt.push(emballer(s));
    if (alt.length >= 3) break;
  }
  res.alternatives = alt;
  return res;
}
if (typeof module !== "undefined") module.exports = { calculerPose, projeter, rodrigues, eulerR, versRvec };
