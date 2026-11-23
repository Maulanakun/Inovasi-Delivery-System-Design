// Aturan zona diambil dari triage() di POV Pasien agar hasil backend = hasil frontend.
const SYMPTOMS = {
  'Batuk': 7, 'Pilek atau hidung tersumbat': 7, 'Demam': 3, 'Pusing': 3,
  'Mual atau tidak nafsu makan': 3, 'Lemas': 3,
  'Sesak bertambah dari biasanya': 0, 'Kaki atau perut bengkak bertambah': 0,
  'Jantung berdebar': 0, 'Batuk malam atau sulit tidur datar': 0,
};
export const SYMPTOM_LIST = Object.keys(SYMPTOMS);

const has = (v) => v !== null && v !== undefined && !Number.isNaN(v);

export function triage(e) {
  const red = [];
  const yellow = [];

  if (e.chestPain) {
    const { scale, radiates, relievedByRest } = e.chestPain;
    if (scale >= 8) red.push(`Nyeri dada skala ${scale}`);
    if (radiates && radiates !== 'Tidak menjalar') red.push(`Nyeri dada menjalar ke ${radiates.toLowerCase()}`);
    if (relievedByRest === false) red.push('Nyeri dada tidak hilang saat istirahat');
    if (!red.length) yellow.push('Nyeri dada ringan yang perlu dinilai dokter');
  }
  if (e.restDyspnea) red.push('Sesak saat istirahat');
  if (e.syncope) red.push('Pingsan atau hampir pingsan');

  if (has(e.systolic)) {
    if (e.systolic >= 180 || e.systolic < 90) red.push(`Tekanan darah sistolik ${e.systolic} mmHg`);
    else if (e.systolic >= 160 || e.systolic < 100)
      yellow.push(`Tekanan darah ${e.systolic}/${e.diastolic ?? '-'} mmHg di luar batas aman`);
  }
  if (has(e.pulse)) {
    if (e.pulse > 130 || e.pulse < 40) red.push(`Nadi ${e.pulse} per menit`);
    else if (e.pulse > 110 || e.pulse < 50) yellow.push(`Nadi ${e.pulse} per menit`);
  }
  if (has(e.glucose)) {
    if (e.glucose < 54) red.push(`Gula darah ${e.glucose} mg/dL sangat rendah`);
    else if (e.glucose < 70 || e.glucose >= 200) yellow.push(`Gula darah ${e.glucose} mg/dL di luar batas`);
  }
  if (has(e.cholesterol) && e.cholesterol >= 240) yellow.push(`Kolesterol total ${e.cholesterol} mg/dL tinggi`);
  if (has(e.uricAcid) && e.uricAcid > 7) yellow.push(`Asam urat ${e.uricAcid} mg/dL tinggi`);
  if (has(e.weightDelta) && e.weightDelta >= 2)
    yellow.push(`Berat badan naik ${e.weightDelta.toFixed(1).replace('.', ',')} kg dalam 3 hari`);

  for (const s of e.symptoms ?? []) {
    const days = SYMPTOMS[s];
    if (days === undefined) continue;
    if (days === 0) yellow.push(s);
    else if ((e.durationDays ?? 0) >= days) yellow.push(`${s} sudah ${e.durationDays} hari`);
  }

  const zona = red.length ? 'merah' : yellow.length ? 'kuning' : 'hijau';
  return { zona, reasons: red.length ? red : yellow };
}

export const ADVICE = {
  merah: 'Segera ke IGD atau hubungi 119. Jangan menunggu jadwal kontrol.',
  kuning: 'Hubungi perawat hari ini lewat TEMU B (chat/telepon). Jangan mengubah obat sendiri.',
  hijau: 'Kondisi stabil. Lanjutkan obat, batasi garam dan cairan, catat lagi besok.',
};
