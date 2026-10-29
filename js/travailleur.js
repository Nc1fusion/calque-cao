// Fil de calcul : tout le travail lourd se fait ici pour garder l'affichage fluide.
importScripts("solveur.js", "modeles.js", "recalage.js");

let M = null;
const versGris = (p, s) => { const q = p.slice(); q[6] += Math.log(s); return q; };
const versImage = (p, s) => { const q = p.slice(); q[6] -= Math.log(s); return q; };
const resumeTrous = t => t.map(x => ({ etat: x.etat, decalage: x.decalage, dir: x.dir, signe: x.rebord.signe, relatif: x.relatif }));

onmessage = e => {
  const m = e.data;
  try {
    if (m.cmd === "modele") { M = construireModele(m.type, m.D, m.trous); postMessage({ id: m.id, ok: true }); return; }
    const s = m.gris.w / m.wImg, cx = m.gris.w / 2, cy = m.gris.h / 2;
    if (m.cmd === "demarrer") {
      const r = recalerDepuisReperes(m.gris, M, m.P3, m.P2, m.wImg, m.hImg);
      if (!r) { postMessage({ id: m.id, cmd: m.cmd, erreur: "pose" }); return; }
      postMessage({ id: m.id, cmd: m.cmd, p: versImage(r.p, s), qualite: r.qualite });
    } else if (m.cmd === "suivre") {
      const t = performance.now();
      const r = suivrePose(m.gris, M, versGris(m.p, s), cx, cy);
      postMessage({ id: m.id, cmd: m.cmd, p: versImage(r.p, s), qualite: r.qualite, perdu: r.perdu, ms: performance.now() - t });
    } else if (m.cmd === "accrocher") {
      const r = accrocherPose(m.gris, M, versGris(m.p, s), cx, cy);
      postMessage({ id: m.id, cmd: m.cmd, p: versImage(r.p, s), qualite: r.qualite });
    } else if (m.cmd === "controler") {
      // image pleine résolution : on affine la pose (focale fixe), puis on contrôle les trous
      const pg = versGris(m.p, s);
      const r = suivrePose(m.gris, M, pg, cx, cy);
      const G = preparerNiveau(m.gris, 0.8 * Math.min(m.gris.w, m.gris.h) / 1000 + 0.6);
      const trous = r.qualite >= 0.45 ? resumeTrous(jugerRelatif(M, controleTrous(G, M, r.p, cx, cy, m.tol), m.tol)) : null;
      postMessage({ id: m.id, cmd: m.cmd, p: versImage(r.p, s), qualite: r.qualite, trous });
    }
  } catch (err) { postMessage({ id: m.id, cmd: m.cmd, erreur: String(err && err.stack || err) }); }
};
