# Tenflow: Platform Attendance Performance

Implementasi PRD `PRD Platform Attendance Performance.md` (Fase 1 + Fase 2), dengan perhitungan yang diselaraskan ke sheet **Final Data** pada `Anonymized Data.xlsx`. Aplikasi web React + TypeScript yang berjalan sepenuhnya di browser: file diproses di memori dan tidak dikirim ke server mana pun.

Panduan pengguna (alur HR, flag, dan seluruh parameter Config): [USER-MANUAL.md](USER-MANUAL.md).

## Menjalankan

```
npm install
npm run dev          # http://localhost:5173
npm run sample       # memecah "Anonymized Data.xlsx" menjadi sample-data/fingerprint.xlsx + hris.xlsx (git-ignored)
npm test             # vitest; jika sample-data ada, juga membuktikan hasil == sheet Final Data
npm run build        # typecheck + build produksi
```

Akun demo (tanpa kata sandi): `hr@tenflow.demo` (HR) dan `admin@tenflow.demo` (Admin). Timeout sesi 3 jam; untuk uji, `VITE_SESSION_MINUTES=0.25 npm run dev`.

## Hak akses

HR: Proses Attendance + Dashboard. Admin: semua yang bisa dilakukan HR, ditambah Settings & Config (hanya Admin). Ini melonggarkan PRD FR-02/FR-38 (Admin tanpa akses data karyawan) atas permintaan pemilik produk.

## Perhitungan (selaras dengan Final Data)

Sumber kebenaran: rumus pada sheet *Master Data* dan *Final Data*.

1. **Master Data** = satu baris per karyawan per hari yang punya tap fingerprint. Jam Masuk = tap paling awal, Jam Pulang = tap paling akhir (apa pun statusnya, sehingga hari dengan satu tap berjam masuk = jam pulang).
2. **Work Schedule** karyawan (REGULER / SHIFTING / SHIFTING OB) = jadwal berprioritas tertinggi dari kode shift HRIS-nya (tabel pemetaan di Config). Terbukti cocok untuk 86/86 karyawan.
3. **Status** (Config → Work Schedule): REGULER terlambat jika masuk > 09:15, pulang awal jika pulang < 18:00; SHIFTING 07:15 / 16:00; SHIFTING OB 06:15 / 15:00, dan bila tap masuk ≥ 10:00 maka 10:15 / 19:00.
4. **Final Data** (20 kolom, urutan dan nama sama dengan sheet asli): Actual Clock In/Out = jumlah hari ber-tap; Late Arrival Count; Early Clock Out Count; **% Complete = (Late + Early) ÷ (Clock In + Clock Out)**; Remarks "Perlu Evaluasi" bila > 20 %; Week 1–5 = hari kerja (Sen–Jum) di kantor per minggu (minggu mulai Senin); Total Office Attendance; **% Keterlambatan Clock In = Late ÷ Clock In**; Remarks "Late >20%".
5. File hasil memakai rumus Excel asli (COUNTIFS dari Master Data, dicocokkan lewat Employee ID, bukan nama) dengan nilai tersimpan, sehingga dapat diaudit di Excel.

Test `reproduces the "Final Data" sheet` menjalankan seluruh pipeline pada sheet Fingerprint + HRIS dan membandingkan dengan Final Data: 86 baris, 0 selisih (Clock In/Out, Late, Early, % Complete, Remarks, Week 1–5, Total, Work Schedule, % Keterlambatan, Remarks Late).

## Evaluasi attendance dan kepatuhan WFO (dokumen `[Edge Case] Attendance System.pdf`)

Lapisan evaluasi (`src/lib/compliance.ts`, `leave.ts`) memisahkan lima hal: kehadiran fisik (hanya fingerprint), status cuti/WFH (Talenta), kategori jadwal (HRIS), kepatuhan, dan status review. Layar **Evaluasi & WFO** (antara Review dan Pratinjau) menampilkan Ringkasan, Harian (filter + penjelasan "mengapa status ini"), Kepatuhan WFO per karyawan per minggu, Shift & jadwal, dan Kualitas data. Angka layar, sheet **Daily Evaluation** / **WFO Compliance** pada export, dan Dashboard berasal dari fungsi yang sama dan diuji agar cocok.

**Perubahan perilaku yang disengaja:** terlambat/pulang awal kini dinilai terhadap **jam shift HRIS pada hari itu** (Schedule In + toleransi 15 menit; Schedule Out), bukan ambang Work Schedule satu karyawan sepanjang bulan. Pada data contoh 6 dari 86 baris Final Data berubah (hari bershift N dinilai dengan ambang OB, S2 dinilai seolah mulai 07:00, dst.). Parameter `Dasar jadwal` = 0 di Config mengembalikan rumus sheet perusahaan; pembuktian 86/86 baris tanpa selisih diuji pada mode ini.

- **WFO wajib per minggu** (Senin–Minggu, dipotong sesuai periode) = maks(0, min(4, hari terjadwal − cuti disetujui − jatah WFH 1)); **terkredit** = min(WFO fisik, wajib); **kepatuhan** = Σ terkredit ÷ Σ wajib. WFH tidak pernah menjadi WFO.
- **Tidak patuh** hanya bila selisih tetap ada walau semua hari yang belum pasti berpihak pada karyawan; selain itu **Perlu review HR**. Tidak ada fingerprint bukan bukti absen.
- **Karyawan tanpa fingerprint sama sekali** (ID hanya ada di HRIS) tidak di-flag dan dinilai dari data HRIS: Check In Talenta mereka dihitung hadir di kantor untuk kepatuhan WFO (keputusan HR, parameter `hrisOnlyPresence`). Mereka tetap tidak masuk Final Data, dan terlambat/pulang awal tidak dihitung untuk mereka karena tidak ada tap.
- **Cuti** mengurangi kewajiban hanya bila status Approved tersedia. Cuti tanpa periode dibaca seharian, kecuali ALR dengan kedua tap yang memenuhi aturan HR (masuk tepat waktu + pulang saat/sebelum istirahat siang = cuti sore; masuk setelah istirahat siang + pulang tepat waktu = cuti pagi; parameter `inferHalfDayAlr`, perlu konfirmasi HR). Kode cuti dengan tap yang menutup seluruh shift (tidak terlambat, tidak pulang awal) dibaca hadir penuh tanpa flag (`leaveWorkedFullDay`, perlu konfirmasi HR). Hari berkode H dengan tap sebelah saja dianggap lupa tap: hadir, tanpa flag, sisi kosong tidak dinilai (`forgotTapWhenPresent`, perlu konfirmasi HR). Divisi fleksibel (bawaan COM, tab Config "Divisi fleksibel"): tap sebelah dianggap hadir apa pun kodenya dan durasi tidak wajar tidak di-flag (perlu konfirmasi HR). Cuti setengah hari yang disetujui (kolom `Leave Period` AM/PM atau `Leave Start/End`) dan konsisten dengan tap menggeser batas terlambat/pulang awal, tanpa flag; tap di dalam periode cuti, cuti tanpa persetujuan, atau cuti bertemu tap tanpa periode di-flag konflik.
- **Kolom opsional** pada HRIS: `Approval Status`, `Leave Period`, `Leave Start`, `Leave End`, `Work Location` (WFH/WFO), `Check In`, `Check Out`; pada Fingerprint: `Kategori`. Kolom yang tidak ada = tidak diketahui, tidak pernah dibaca sebagai disetujui/seharian/WFH. Data contoh tidak memuat `Approval Status`, jam cuti, kategori fingerprint, maupun kode WFH.
- **Hari dengan satu tap saja** (hanya masuk / hanya pulang): (1) bila Check Out (Check In) Talenta ada dan masuk akal, jam yang hilang diambil dari sana, hari tidak di-flag dan ditandai "dilengkapi Talenta" (parameter `talentaFillsMissingTap`; kehadiran fisik tetap dari fingerprint); (2) cuti setengah hari yang disetujui atau dinas yang disetujui menjelaskan sisi yang hilang dan sisi itu tidak dinilai; (3) sisanya di-flag, dan HR memutuskan dengan template alasan (meeting/dinas luar, cuti setengah hari, sakit setengah hari, lupa tap, data tidak valid). Talenta tidak mencatat cuti setengah hari (1 ALR = 2 setengah hari), sehingga cuti setengah hari hanya bisa dikenali lewat keputusan HR, atau kolom `Leave Period` / `Leave Start/End` bila suatu saat tersedia.
- **Dinas / meeting luar:** tambahkan kode Talenta-nya di Config → Kode kehadiran dengan perlakuan "Dinas / meeting luar kantor" (tidak ada kode bawaan). Bila disetujui: tap yang hanya sebelah tidak di-flag dan sisi yang hilang tidak dinilai; tanpa fingerprint hari itu bukan WFO dan bukan WFH, dan mengurangi kewajiban WFO seperti cuti disetujui.
- **Duplikasi:** tap yang digabung (persis sama atau mendekati) tetap tercantum pada kolom bukti; baris HRIS identik dilipat dengan peringatan, baris HRIS yang berbeda dipertahankan dan di-flag; memproses ulang input yang sama menghasilkan hasil yang sama.
- **Hasil override tidak menghapus hasil sistem:** Daily Evaluation menyimpan hasil sistem, keputusan HR (siapa, kapan, alasan), dan hasil akhir.

### Keputusan kebijakan yang menunggu konfirmasi HR
Semua tersedia di Config → Parameter dan tercatat di versi rule: dasar jadwal (shift HRIS vs Work Schedule), toleransi terlambat 15 menit / pulang awal 0 menit, istirahat siang 12:00–13:00 untuk cuti setengah hari tanpa jam, toleransi tap di tepi periode cuti (15 menit), cuti tanpa status persetujuan dianggap disetujui (nilai awal: tidak), catatan Talenta tanpa fingerprint = WFH (nilai awal: ya, sesuai contoh dokumen), 4 hari WFO / jatah WFH 1 hari, apakah cuti menghabiskan jatah WFH, ambang kepatuhan 100%, dan berlakunya aturan 4:1 untuk karyawan shifting.

## Alur

- **Proses Attendance**: upload Fingerprint + HRIS → validasi → hitung → review flag (accept / override / exclude, alasan wajib, bulk untuk flag sejenis) → pratinjau Final Data + panel ringkasan + checkbox → export. Export terkunci selama ada flag belum diputuskan. Hari dengan flag belum diputuskan tidak dihitung; **accept** = pakai hasil rumus perusahaan apa adanya.
- **File hasil** (.xlsx): **Final Data** (format perusahaan, tanpa perubahan), Master Data (traceability), Exception (kasus, keputusan, alasan), Audit Trail (snapshot rule, statistik proses), Metadata (skema, periode, versi rule, checksum SHA-256).
- **Dashboard**: 1 file = bulanan (distribusi dan rata-rata % Complete dan % Keterlambatan, jumlah Perlu Evaluasi / Late, per departemen, ringkasan exception), ≥ 2 file = tren (bulan bolong = gap, periode ganda ditolak, peringatan beda rule beserta diff, peringatan checksum tidak cocok). Cetak/simpan PDF lewat dialog cetak browser.
- **Settings & Config (Admin)**: parameter, Work Schedule, pemetaan shift, kode kehadiran; tiap perubahan = versi baru + log; hapus dengan konfirmasi; versi lama read-only.
- Navigasi kiri dapat disembunyikan (preferensi tersimpan).

## Flag (FR-13..19)

Data tidak lengkap (satu tap yang tidak terjelaskan oleh Talenta/cuti/dinas, kolom kosong, tanpa departemen), tidak cocok (ID hanya di salah satu sumber), ambigu (jadwal campuran, tap pada tanggal tanpa jadwal HRIS, status tap tidak dikenal). Tap pada hari libur (dayoff / national holiday) dianggap tidak ada: tidak di-flag dan tidak dihitung (parameter `ignoreDayOffTaps`; jumlah harinya dilaporkan di validasi dan Audit Trail; mode 0 mengembalikan perilaku sheet perusahaan). Beberapa tap masuk/pulang, urutan tap tidak berpasangan, dan tap di luar jam shift bukan exception: jam masuk = tap paling awal, jam pulang = tap paling akhir, tidak ada rule (shift belum dipetakan, kode kehadiran tak dikenal, shift lintas hari), konflik (kode cuti/izin/sakit bertemu tap), di luar batas wajar (durasi). Peringatan kualitas data bila rasio flag melebihi ambang Config.

## Keterbatasan

- Tidak ada backend: login hanya email dummy; aturan dan log disimpan di `localStorage` browser (tidak dibagikan antar pengguna).
- **Line Manager** tidak ada di file sumber mana pun (di sheet asli diketik manual), jadi kolomnya kosong kecuali HRIS memiliki kolom opsional `Line Manager`.
- Hari tanpa tap tidak dihitung (sama seperti sheet asli): tidak ada konsep alpa. Kode cuti hanya dipakai untuk mendeteksi konflik dengan tap.
- Shift lintas hari: tap pulang hari berikutnya digabung, tetapi ambang jam untuk shift malam belum ada di data contoh sehingga di-flag "tidak ada rule".
- Checksum mendeteksi perubahan, bukan tanda tangan digital. Sel rumus bernilai 0 tidak menyimpan nilai cache (batasan exceljs); Excel menghitung ulang saat dibuka.
- Timeout pemrosesan 2 menit memakai `Promise.race`; pekerjaan di main thread tidak bisa dibatalkan (belum Web Worker).
- Waktu diperlakukan sebagai jam dinding tanpa konversi zona waktu (nilai Excel dibaca sebagai bidang UTC apa adanya, tidak bergantung zona waktu mesin). Belum ada ESLint dan uji UI otomatis di repo (UI diverifikasi manual dengan browser).
- Tidak ada backend, basis data, atau migrasi: audit trail ada di file hasil dan log rule di `localStorage`. Pembatasan peran (`src/access.ts`) hanya penjaga UI, bukan batas keamanan; otorisasi sungguhan memerlukan server.
- Hari tanpa tap tidak menghasilkan flag yang memblokir export; statusnya (WFH, cuti, tanpa bukti) ditampilkan sebagai "belum pasti" pada Evaluasi dan sheet WFO Compliance.
- Aturan 4:1 diterapkan ke semua kategori jadwal; apakah karyawan shifting dikecualikan belum ditetapkan.
