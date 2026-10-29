// ---- Recalage automatique sur les arêtes (style RAPiD / ViSP / VisionLib), pièce quelconque ----
// Modèle M = {V: sommets, E: arêtes [i,j], T: triangles pour la profondeur, trous}
function flouGauss(img, sigma) {
  const { w, h, data } = img, r = Math.max(1, Math.ceil(sigma * 3)), n = 2 * r + 1, k = new Float32Array(n);
  let s = 0; for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k[i + r] = v; s += v; }
  for (let i = 0; i < n; i++) k[i] /= s;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let a = 0;
      if (x >= r && x < w - r) { const b = o + x - r; for (let i = 0; i < n; i++) a += data[b + i] * k[i]; }
      else for (let i = -r; i <= r; i++) { const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i; a += data[o + xx] * k[i + r]; }
      tmp[o + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    const interieur = y >= r && y < h - r;
    for (let x = 0; x < w; x++) {
      let a = 0;
      if (interieur) { let b = (y - r) * w + x; for (let i = 0; i < n; i++, b += w) a += tmp[b] * k[i]; }
      else for (let i = -r; i <= r; i++) { const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i; a += tmp[yy * w + x] * k[i + r]; }
      out[y * w + x] = a;
    }
  }
  return { w, h, data: out };
}
function sobel(img) {
  const { w, h, data: d } = img, gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    gx[i] = (d[i - w + 1] + 2 * d[i + 1] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - 1] - d[i + w - 1]) / 8;
    gy[i] = (d[i + w - 1] + 2 * d[i + w] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - w] - d[i - w + 1]) / 8;
  }
  return { gx, gy };
}
function seuilGradient(gx, gy) {
  // 90e centile de la force du gradient, par histogramme (rapide)
  const n = gx.length, pas = Math.max(1, Math.floor(n / 60000)), hist = new Uint32Array(1024);
  let tot = 0;
  for (let i = 0; i < n; i += pas) { const m = Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]); hist[Math.min(1023, (m * 4) | 0)]++; tot++; }
  let c = 0, k = 0; const cible = tot * 0.9;
  for (; k < 1024; k++) { c += hist[k]; if (c >= cible) break; }
  return Math.max(2, (k / 4) * 0.5);
}
function bilin(a, w, h, x, y) {
  x = Math.min(w - 1.001, Math.max(0, x)); y = Math.min(h - 1.001, Math.max(0, y));
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return a[i] * (1 - fx) * (1 - fy) + a[i + 1] * fx * (1 - fy) + a[i + w] * (1 - fx) * fy + a[i + w + 1] * fx * fy;
}
function preparerNiveau(gris, sigma) {
  const f = flouGauss(gris, sigma), { gx, gy } = sobel(f);
  return { w: gris.w, h: gris.h, gx, gy, seuil: seuilGradient(gx, gy) };
}

// projection rapide : rotation et focale calculées une seule fois par pose
function projecteur(p, cx, cy) {
  const R = rodrigues(p), f = Math.exp(p[6]), t0 = p[3], t1 = p[4], t2 = p[5];
  return P => {
    const z = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t2;
    return [f * (R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t0) / z + cx, f * (R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t1) / z + cy, z];
  };
}
// tampon de profondeur (mm) des triangles du modèle
function zbuffer(M, p, cx, cy, w, h) {
  const zb = new Float32Array(w * h).fill(Infinity);
  const pj = projecteur(p, cx, cy), Q = M.V.map(pj);
  for (const [i0, i1, i2] of M.T) {
    const a = Q[i0], b = Q[i1], c = Q[i2];
    if (a[2] <= 1 || b[2] <= 1 || c[2] <= 1) continue;
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(den) < 1e-9) continue;
    const xmin = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), xmax = Math.min(w - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const ymin = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), ymax = Math.min(h - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const ia = 1 / a[2], ib = 1 / b[2], ic = 1 / c[2];
    for (let y = ymin; y <= ymax; y++) {
      const py = y + 0.5;
      for (let x = xmin; x <= xmax; x++) {
        const px = x + 0.5;
        const l0 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / den;
        const l1 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / den;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
        const z = 1 / (l0 * ia + l1 * ib + l2 * ic), k = y * w + x;
        if (z < zb[k]) zb[k] = z;
      }
    }
  }
  return zb;
}
function estVisible(zb, w, h, q, tol) {
  if (!(q[2] > 1 && q[0] >= 0 && q[0] < w && q[1] >= 0 && q[1] < h)) return false;
  const xi = Math.round(q[0] - 0.5), yi = Math.round(q[1] - 0.5);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = Math.min(w - 1, Math.max(0, xi + dx)), yy = Math.min(h - 1, Math.max(0, yi + dy));
    if (zb[yy * w + xx] >= q[2] - tol) return true;
  }
  return false;
}
// points le long des arêtes, visibles, avec la recherche 1D le long de la normale
function mesurer(G, M, p, cx, cy, L, pasPx, zb, filtreAretes) {
  const pj = projecteur(p, cx, cy), pts = [], Q = M.V.map(pj);
  const liste = filtreAretes || M.E.map((_, i) => i);
  for (const e of liste) {
    const [a, b] = M.E[e], qa = Q[a], qb = Q[b];
    if (qa[2] <= 1 || qb[2] <= 1) continue;
    let tx = qb[0] - qa[0], ty = qb[1] - qa[1]; const lg = Math.hypot(tx, ty); if (lg < 1) continue;
    tx /= lg; ty /= lg; const nx = -ty, ny = tx;
    const n = Math.floor(lg / pasPx), ts = n < 2 ? [0.5] : Array.from({ length: n }, (_, k) => 0.08 + 0.84 * k / (n - 1));
    for (const t of ts) {
      const P = [0, 1, 2].map(i => M.V[a][i] + t * (M.V[b][i] - M.V[a][i]));
      const q = pj(P);
      const vis = estVisible(zb, G.w, G.h, q, 3);
      if (!vis) { pts.push({ P, e, vis: false, ok: false }); continue; }
      let meilleur = -1, kb = 0; const prof = [];
      for (let o = -L; o <= L; o++) {
        const x = q[0] + o * nx, y = q[1] + o * ny;
        const g = Math.abs(bilin(G.gx, G.w, G.h, x, y) * nx + bilin(G.gy, G.w, G.h, x, y) * ny) * Math.exp(-0.5 * (o / (0.7 * L)) ** 2);
        prof.push(g); if (g > meilleur) { meilleur = g; kb = o + L; }
      }
      if (meilleur <= G.seuil) { pts.push({ P, e, vis: true, ok: false }); continue; }
      let sub = 0;
      if (kb > 0 && kb < prof.length - 1) { const A = prof[kb - 1], B = prof[kb], D = prof[kb + 1], den = A - 2 * B + D; if (Math.abs(den) > 1e-9) sub = Math.max(-0.5, Math.min(0.5, 0.5 * (A - D) / den)); }
      const d = kb - L + sub;
      pts.push({ P, e, vis: true, ok: true, nx, ny, cible: [q[0] + d * nx, q[1] + d * ny], d });
    }
  }
  return pts;
}
function iterer(G, M, p, cx, cy, L, libres, pasPx, zbFourni) {
  const zb = zbFourni || zbuffer(M, p, cx, cy, G.w, G.h);
  const pts = mesurer(G, M, p, cx, cy, L, pasPx, zb).filter(o => o.ok);
  if (pts.length < 15) return { p, ok: false };
  const resid = pp => {
    const r = [];
    const pj = projecteur(pp, cx, cy);
    for (const o of pts) { const q = pj(o.P); if (q[2] <= 1 || !isFinite(q[0])) return null; r.push((q[0] - o.cible[0]) * o.nx + (q[1] - o.cible[1]) * o.ny); }
    return r;
  };
  let lam = 1e-3;
  for (let it = 0; it < 4; it++) {
    const r = resid(p); if (!r) break;
    const med = r.slice().sort((a, b) => a - b)[r.length >> 1];
    const mad = r.map(v => Math.abs(v - med)).sort((a, b) => a - b)[r.length >> 1];
    const c = 4.685 * (1.4826 * mad + 0.5);
    const wts = r.map(v => Math.abs(v) >= c ? 0 : (1 - (v / c) ** 2) ** 2);
    const cout = rr => rr.reduce((s, v) => s + Math.min((v / c) ** 2, 1), 0);
    const J = libres.map(k => {
      const q = p.slice(), hh = (k < 3 || k === 6) ? 1e-6 : 1e-3; q[k] += hh;
      const r2 = resid(q) || r; return r2.map((v, i) => (v - r[i]) / hh);
    });
    const n = libres.length, H = [], g = [];
    for (let a = 0; a < n; a++) {
      H.push([]); let s = 0; for (let i = 0; i < r.length; i++) s += J[a][i] * wts[i] * r[i]; g.push(-s);
      for (let b = 0; b < n; b++) { let t = 0; for (let i = 0; i < r.length; i++) t += J[a][i] * wts[i] * J[b][i]; H[a].push(t); }
    }
    let accepte = false;
    for (let e = 0; e < 6; e++) {
      const d = resoudreLin(H.map((row, i) => row.map((v, j) => i === j ? v + lam * (v + 1e-9) : v)), g);
      if (!d) { lam *= 10; continue; }
      const pn = p.slice(); libres.forEach((k, i) => pn[k] += d[i]);
      const rn = resid(pn);
      if (rn && cout(rn) <= cout(r)) { p = pn; lam = Math.max(lam / 10, 1e-7); accepte = true; break; }
      lam *= 10;
    }
    if (!accepte) break;
  }
  return { p, ok: true };
}
function qualitePose(G, M, p, cx, cy) {
  const L = Math.max(3, Math.round(0.004 * Math.min(G.w, G.h)));
  const zb = zbuffer(M, p, cx, cy, G.w, G.h);
  // contour de la pièce seulement (les trous sont jugés à part)
  const contour = Array.from({ length: M.nbAretesContour || M.E.length }, (_, i) => i);
  const pts = mesurer(G, M, p, cx, cy, L, Math.max(4, Math.min(G.w, G.h) / 150), zb, contour).filter(o => o.vis);
  if (!pts.length) return 0;
  return pts.filter(o => o.ok && Math.abs(o.d) <= 2.5).length / pts.length;
}
// gris : image de travail ; p : pose en pixels de cette image
function recalerPose(gris, M, p0, cx, cy) {
  const cote = Math.min(gris.w, gris.h), pasPx = Math.max(4, cote / 150), niveaux = {};
  const niv = s => niveaux[s] || (niveaux[s] = preparerNiveau(gris, s * cote / 1000 + 0.6));
  const passe = (p, etapes, libres) => {
    for (const [frac, s] of etapes) {
      const G = niv(s), L = Math.max(4, Math.round(frac * cote));
      for (let k = 0; k < 5; k++) {
        const avant = p.slice(), res = iterer(G, M, p, cx, cy, L, libres, pasPx);
        p = res.p; if (!res.ok) break;
        const dr = Math.max(...[0, 1, 2].map(i => Math.abs(p[i] - avant[i]))), dt = Math.max(...[3, 4, 5].map(i => Math.abs(p[i] - avant[i])));
        if (dr < 1e-5 && dt < 0.05) break;
      }
    }
    return p;
  };
  const Gq = niv(0.8);
  const p1 = passe(p0.slice(), [[0.05, 3], [0.03, 2], [0.018, 1.2], [0.01, 0.8]], [0, 1, 2, 3, 4, 5]);
  const q1 = qualitePose(Gq, M, p1, cx, cy);
  const p2 = passe(p1.slice(), [[0.018, 1.2], [0.01, 0.8], [0.007, 0.6]], [0, 1, 2, 3, 4, 5, 6]);
  const fOk = Math.exp(p2[6]) > 0.3 * Math.max(gris.w, gris.h) && Math.exp(p2[6]) < 3 * Math.max(gris.w, gris.h);
  const q2 = fOk ? qualitePose(Gq, M, p2, cx, cy) : -1;
    return q2 > q1 + 0.02 ? { p: p2, qualite: q2, focaleAjustee: true, Gq } : { p: p1, qualite: q1, focaleAjustee: false, Gq };
}
// contrôle des trous : on cherche où se trouve VRAIMENT le rebord dans la photo, en faisant glisser
// le cercle du modèle dans le plan de la plaque (±15 mm) ; la meilleure position donne le décalage en mm.
function controleTrous(G, M, p, cx, cy, tolMm = 6) {
  const zb = zbuffer(M, p, cx, cy, G.w, G.h);
  const R = rodrigues(p), t = p.slice(3, 6);
  const cam = [0, 1, 2].map(i => -(R[i] * t[0] + R[3 + i] * t[1] + R[6 + i] * t[2]));
  return M.trous.map(tr => {
    const rb = tr.rebords.find(r => ((cam[0] - r.centre[0]) * tr.axe[0] + (cam[1] - r.centre[1]) * tr.axe[1] + (cam[2] - r.centre[2]) * tr.axe[2]) * r.signe > 0) || tr.rebords[0];
    // points du rebord (milieux et extrémités des segments) + vecteur radial 3D
    const pts = [];
    for (const e of rb.aretes) {
      const [a, b] = M.E[e];
      for (const s of [0, 0.5]) {
        const P = [0, 1, 2].map(i => M.V[a][i] + s * (M.V[b][i] - M.V[a][i]));
        const rad = norm3([0, 1, 2].map(i => P[i] - rb.centre[i]));
        const q = projeter(P, p, cx, cy);
        pts.push({ P, rad, vis: estVisible(zb, G.w, G.h, q, 3) });
      }
    }
    const visibles = pts.filter(o => o.vis);
    if (visibles.length < 12 || visibles.length / pts.length < 0.5) return { etat: "cache", rebord: rb };
    // deux directions dans le plan de la plaque
    const a = tr.axe, u0 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const v1 = norm3(cross3(a, u0)), v2 = cross3(a, v1);
    const score = (du, dv) => {
      let s = 0, n = 0;
      for (const o of visibles) {
        const P = [0, 1, 2].map(i => o.P[i] + du * v1[i] + dv * v2[i]);
        const P2 = [0, 1, 2].map(i => P[i] + 0.5 * o.rad[i]);   // pour la direction radiale à l'écran
        const q = projeter(P, p, cx, cy), q2 = projeter(P2, p, cx, cy);
        let nx = q2[0] - q[0], ny = q2[1] - q[1]; const l = Math.hypot(nx, ny); if (l < 1e-6) continue;
        nx /= l; ny /= l;
        const g = Math.abs(bilin(G.gx, G.w, G.h, q[0], q[1]) * nx + bilin(G.gy, G.w, G.h, q[0], q[1]) * ny);
        s += Math.min(g / G.seuil, 8); n++;
      }
      return n ? s / n : 0;
    };
    let best = { du: 0, dv: 0, s: -1 };
    for (let du = -15; du <= 15; du += 1) for (let dv = -15; dv <= 15; dv += 1) {
      const s = score(du, dv) * (1 - 0.004 * Math.hypot(du, dv)); if (s > best.s) best = { du, dv, s };
    }
    for (let du = best.du - 0.75; du <= best.du + 0.75; du += 0.25) for (let dv = best.dv - 0.75; dv <= best.dv + 0.75; dv += 0.25) {
      const s = score(du, dv) * (1 - 0.004 * Math.hypot(du, dv)); if (s > best.s) best = { du, dv, s };
    }
    const s0 = score(0, 0), decalage = Math.hypot(best.du, best.dv);
    const dir = [0, 1, 2].map(i => best.du * v1[i] + best.dv * v2[i]);   // décalage en mm dans le repère pièce
    let etat;
    if (best.s < 0.45) etat = "absent";                       // aucun cercle net trouvé
    else if (decalage <= tolMm) etat = "ok";
    else etat = "decale";
    return { etat, decalage, dir, score: best.s, score0: s0, rebord: rb };
  });
}
// relances : si l'alignement est mauvais, on recommence avec d'autres focales de départ et on garde le meilleur
function recalerDepuisReperes(gris, M, P3, P2img, wImg, hImg) {
  const s = gris.w / wImg; let meilleur = null;
  const essayer = d => {
    const p0 = d.p.slice(); p0[6] += Math.log(s);
    const r = recalerPose(gris, M, p0, d.cx * s, d.cy * s); r.depart = d;
    if (!meilleur || r.qualite > meilleur.qualite) meilleur = r;
  };
  const d1 = calculerPose(P3, P2img, wImg, hImg, 1); if (!d1) return null;
  essayer(d1);
  // si ça colle mal : autres solutions des repères, puis autres focales de départ
  const relances = [...(d1.alternatives || [])];
  for (const fac of [0.8, 1.25]) { const d = calculerPose(P3, P2img, wImg, hImg, fac); if (d) relances.push(d); }
  for (const d of relances) { if (meilleur.qualite >= 0.62) break; essayer(d); }
  return meilleur;
}
// suivi vidéo : une image, en partant de la pose de l'image précédente (focale fixée au démarrage)
function suivrePose(gris, M, p0, cx, cy) {
  const cote = Math.min(gris.w, gris.h), pasPx = Math.max(5, cote / 90);
  const G = preparerNiveau(gris, 1.0 * cote / 1000 + 0.6);       // un seul lissage par image
  let p = p0.slice();
  for (const frac of [0.035, 0.015]) {
    const L = Math.max(4, Math.round(frac * cote));
    const zb = zbuffer(M, p, cx, cy, G.w, G.h);                 // visibilité : une fois par étape
    for (let k = 0; k < 3; k++) {
      const avant = p.slice(), res = iterer(G, M, p, cx, cy, L, [0, 1, 2, 3, 4, 5], pasPx, k === 0 ? zb : null);
      p = res.p; if (!res.ok) return { p: p0, qualite: 0, perdu: true };
      const dr = Math.max(...[0, 1, 2].map(i => Math.abs(p[i] - avant[i]))), dt = Math.max(...[3, 4, 5].map(i => Math.abs(p[i] - avant[i])));
      if (dr < 2e-4 && dt < 0.3) break;
    }
  }
  const qualite = qualitePose(G, M, p, cx, cy);
  return { p, qualite, perdu: false };
}
// accrochage : la pièce est à peu près sous le contour (fantôme), on recherche plus large, focale fixe
function accrocherPose(gris, M, p0, cx, cy) {
  const cote = Math.min(gris.w, gris.h), pasPx = Math.max(5, cote / 120);
  let p = p0.slice();
  for (const [frac, s] of [[0.07, 3], [0.04, 2], [0.02, 1.2], [0.012, 0.8]]) {
    const G = preparerNiveau(gris, s * cote / 1000 + 0.6), L = Math.max(4, Math.round(frac * cote));
    for (let k = 0; k < 4; k++) {
      const avant = p.slice(), res = iterer(G, M, p, cx, cy, L, [0, 1, 2, 3, 4, 5], pasPx);
      p = res.p; if (!res.ok) return { p: p0, qualite: 0 };
      const dr = Math.max(...[0, 1, 2].map(i => Math.abs(p[i] - avant[i]))), dt = Math.max(...[3, 4, 5].map(i => Math.abs(p[i] - avant[i])));
      if (dr < 2e-4 && dt < 0.3) break;
    }
  }
  return { p, qualite: qualitePose(preparerNiveau(gris, 0.8 * cote / 1000 + 0.6), M, p, cx, cy) };
}
// jugement relatif : une petite erreur de pose décale tous les trous d'une même plaque de la même façon ;
// on retire ce décalage commun (médiane) et on juge chaque trou par rapport à ses voisins.
function jugerRelatif(M, ct, tol) {
  const plaque = tr => tr.axe.join(",") + "@" + Math.round(tr.c[0] * tr.axe[0] + tr.c[1] * tr.axe[1] + tr.c[2] * tr.axe[2]);
  const groupes = {};
  ct.forEach((c, i) => { if (c.etat === "cache" || c.etat === "absent") return; (groupes[plaque(M.trous[i])] = groupes[plaque(M.trous[i])] || []).push(i); });
  return ct.map((c, i) => {
    if (c.etat === "cache" || c.etat === "absent") return { ...c, relatif: false };
    const gr = groupes[plaque(M.trous[i])];
    if (gr.length < 3) return { ...c, relatif: false };
    const med = [0, 1, 2].map(k => { const v = gr.map(j => ct[j].dir[k]).sort((a, b) => a - b); return v[v.length >> 1]; });
    const dir = [0, 1, 2].map(k => c.dir[k] - med[k]), d = Math.hypot(dir[0], dir[1], dir[2]);
    return { ...c, etat: d > tol ? "decale" : "ok", decalage: d, dir, relatif: true };
  });
}
if (typeof module !== "undefined") module.exports = { jugerRelatif, accrocherPose, suivrePose, recalerDepuisReperes, recalerPose, qualitePose, preparerNiveau, controleTrous, zbuffer, estVisible };
