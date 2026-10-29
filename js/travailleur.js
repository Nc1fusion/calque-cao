// Fil de calcul : tout le travail lourd se fait ici pour garder l'affichage fluide.
importScripts("solveur.js", "modeles.js", "recalage.js", "placement.js");

let M = null;
const versGris = (p, s) => { const q = p.slice(); q[6] += Math.log(s); return q; };
const versImage = (p, s) => { const q = p.slice(); q[6] -= Math.log(s); return q; };
const resumeTrous = t => t.map(x => ({ etat: x.etat, decalage: x.decalage, dir: x.dir, signe: x.rebord.signe, relatif: x.relatif }));

// pivote la pièce autour de son centre : "z" = autour de son axe vertical, "x" = inclinaison vers la caméra
function pivoter(p, axe, deg) {
  const b = M.boite || [[0, 1, 2].map(i => Math.min(...M.reperes.map(r => r[i]))), [0, 1, 2].map(i => Math.max(...M.reperes.map(r => r[i])))];
  const c = [0, 1, 2].map(i => (b[0][i] + b[1][i]) / 2), R0 = rodrigues(p), a = deg * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
  const mul = (A, B) => [0, 1, 2].flatMap(i => [0, 1, 2].map(j => A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j]));
  const R = axe === "z" ? mul(R0, [co, -si, 0, si, co, 0, 0, 0, 1]) : mul([1, 0, 0, 0, co, -si, 0, si, co], R0);
  const Xc = [0, 1, 2].map(i => R0[3 * i] * c[0] + R0[3 * i + 1] * c[1] + R0[3 * i + 2] * c[2] + p[3 + i]);
  const Rc = [0, 1, 2].map(i => R[3 * i] * c[0] + R[3 * i + 1] * c[1] + R[3 * i + 2] * c[2]);
  return [...versRvec(R), Xc[0] - Rc[0], Xc[1] - Rc[1], Xc[2] - Rc[2], p[6]];
}
// glisse la pièce le long de sa plus grande dimension (fraction de cette longueur)
function glisser(p, frac) {
  const b = M.boite || [[0, 1, 2].map(i => Math.min(...M.reperes.map(r => r[i]))), [0, 1, 2].map(i => Math.max(...M.reperes.map(r => r[i])))];
  const L = [0, 1, 2].map(i => b[1][i] - b[0][i]), k = [0, 1, 2].reduce((a, c) => L[c] > L[a] ? c : a, 0), R = rodrigues(p);
  const q = p.slice(); for (let i = 0; i < 3; i++) q[3 + i] += R[3 * i + k] * frac * L[k];
  return q;
}
onmessage = e => {
  const m = e.data;
  try {
    if (m.cmd === "modele") { M = m.M; postMessage({ id: m.id, ok: true }); return; }
    const s = m.gris.w / m.wImg, cx = m.gris.w / 2, cy = m.gris.h / 2;
    if (m.cmd === "demarrer") {
      const r = recalerDepuisReperes(m.gris, M, m.P3, m.P2, m.wImg, m.hImg);
      if (!r) { postMessage({ id: m.id, cmd: m.cmd, erreur: "pose" }); return; }
      postMessage({ id: m.id, cmd: m.cmd, p: versImage(r.p, s), qualite: r.qualite });
    } else if (m.cmd === "auto") {
      const r = placerAuto(m.gris, M);
      postMessage({ id: m.id, cmd: m.cmd, candidats: r.candidats.map(c => ({ p: versImage(c.p, s), qualite: c.qualite, qualiteTrous: c.qualiteTrous })), ms: r.ms });
    } else if (m.cmd === "suivre") {
      const t = performance.now();
      const r = suivrePose(m.gris, M, versGris(m.p, s), cx, cy);
      postMessage({ id: m.id, cmd: m.cmd, p: versImage(r.p, s), qualite: r.qualite, perdu: r.perdu, ms: performance.now() - t });
    } else if (m.cmd === "accrocher") {
      const p0 = versGris(m.p, s);
      let best = accrocherPose(m.gris, M, p0, cx, cy);
      // si ça colle mal : quelques départs voisins (pièce pivotée de ±15° / ±30°, inclinée de ±15°)
      if (m.essais && best.qualite < 0.8) {
        // départs voisins : pièce pivotée, inclinée, ou glissée le long de sa plus grande longueur
        for (const [axe, v] of [["z", 15], ["z", -15], ["x", 15], ["x", -15], ["l", 0.12], ["l", -0.12], ["z", 30], ["z", -30], ["l", 0.25], ["l", -0.25]]) {
          const r = accrocherPose(m.gris, M, axe === "l" ? glisser(p0, v) : pivoter(p0, axe, v), cx, cy);
          if (r.qualite > best.qualite) best = r;
          if (best.qualite >= 0.85) break;
        }
      }
      postMessage({ id: m.id, cmd: m.cmd, p: versImage(best.p, s), qualite: best.qualite });
    } else if (m.cmd === "controler") {
      const r = suivrePose(m.gris, M, versGris(m.p, s), cx, cy);
      const G = preparerNiveau(m.gris, 0.8 * Math.min(m.gris.w, m.gris.h) / 1000 + 0.6);
      const trous = r.qualite >= 0.45 ? resumeTrous(jugerRelatif(M, controleTrous(G, M, r.p, cx, cy, m.tol), m.tol)) : null;
      postMessage({ id: m.id, cmd: m.cmd, p: versImage(r.p, s), qualite: r.qualite, trous });
    }
  } catch (err) { postMessage({ id: m.id, cmd: m.cmd, erreur: String(err && err.stack || err) }); }
};
