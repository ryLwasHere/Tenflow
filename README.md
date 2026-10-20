# Tenflow: Platform Attendance Performance

Implementasi PRD `PRD Platform Attendance Performance.md` (Fase 1 + Fase 2), dengan perhitungan yang diselaraskan ke sheet **Final Data** pada `Anonymized Data.xlsx`. Aplikasi web React + TypeScript yang berjalan sepenuhnya di browser: file diproses di memori dan tidak dikirim ke server mana pun.

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

## Alur

- **Proses Attendance**: upload Fingerprint + HRIS → validasi → hitung → review flag (accept / override / exclude, alasan wajib, bulk untuk flag sejenis) → pratinjau Final Data + panel ringkasan + checkbox → export. Export terkunci selama ada flag belum diputuskan. Hari dengan flag belum diputuskan tidak dihitung; **accept** = pakai hasil rumus perusahaan apa adanya.
- **File hasil** (.xlsx): **Final Data** (format perusahaan, tanpa perubahan), Master Data (traceability), Exception (kasus, keputusan, alasan), Audit Trail (snapshot rule, statistik proses), Metadata (skema, periode, versi rule, checksum SHA-256).
- **Dashboard**: 1 file = bulanan (distribusi dan rata-rata % Complete dan % Keterlambatan, jumlah Perlu Evaluasi / Late, per departemen, ringkasan exception), ≥ 2 file = tren (bulan bolong = gap, periode ganda ditolak, peringatan beda rule beserta diff, peringatan checksum tidak cocok). Cetak/simpan PDF lewat dialog cetak browser.
- **Settings & Config (Admin)**: parameter, Work Schedule, pemetaan shift, kode kehadiran; tiap perubahan = versi baru + log; hapus dengan konfirmasi; versi lama read-only.
- Navigasi kiri dapat disembunyikan (preferensi tersimpan).

## Flag (FR-13..19)

Data tidak lengkap (satu tap, kolom kosong, tanpa departemen), tidak cocok (ID hanya di salah satu sumber), ambigu (tap ganda, tap di luar jam shift, tap di hari libur, jadwal campuran), tidak ada rule (shift belum dipetakan, kode kehadiran tak dikenal, shift lintas hari), konflik (kode cuti/izin/sakit bertemu tap), di luar batas wajar (durasi). Peringatan kualitas data bila rasio flag melebihi ambang Config.

## Keterbatasan

- Tidak ada backend: login hanya email dummy; aturan dan log disimpan di `localStorage` browser (tidak dibagikan antar pengguna).
- **Line Manager** tidak ada di file sumber mana pun (di sheet asli diketik manual), jadi kolomnya kosong kecuali HRIS memiliki kolom opsional `Line Manager`.
- Hari tanpa tap tidak dihitung (sama seperti sheet asli): tidak ada konsep alpa. Kode cuti hanya dipakai untuk mendeteksi konflik dengan tap.
- Shift lintas hari: tap pulang hari berikutnya digabung, tetapi ambang jam untuk shift malam belum ada di data contoh sehingga di-flag "tidak ada rule".
- Checksum mendeteksi perubahan, bukan tanda tangan digital. Sel rumus bernilai 0 tidak menyimpan nilai cache (batasan exceljs); Excel menghitung ulang saat dibuka.
- Timeout pemrosesan 2 menit memakai `Promise.race`; pekerjaan di main thread tidak bisa dibatalkan (belum Web Worker).
- Waktu diperlakukan sebagai jam dinding tanpa konversi zona waktu. Belum ada ESLint dan uji UI otomatis di repo.
