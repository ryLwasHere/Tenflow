# PRD: Platform Attendance Performance

**Status:** Draft v2 (proyek portofolio, data dummy) | **Keputusan terbaru sudah dimasukkan; item bertanda ⚠️ masih terbuka.**

## 1. Ringkasan

Platform web internal untuk mengolah data absensi (fingerprint) dan data HRIS menjadi laporan *attendance performance* dalam persentase, sesuai aturan perusahaan X. Platform menggantikan proses merge, cleaning, dan perhitungan manual di Excel. Platform bersifat **stateless**: tidak menyimpan data karyawan, dan setiap sesi dimulai dari upload file.

**Value proposition:** Memproses attendance performance dengan sistem yang tidak pernah menebak (kasus ragu selalu di-flag dan export terkunci sampai diputuskan manusia), audit trail yang tertanam di file hasil, dan aturan yang dapat diubah lewat halaman Config tanpa kode, tanpa menyimpan data karyawan. Pembeda dari template Excel atau macro bukan kemudahan drag & drop, melainkan ketiga hal tersebut.

## 2. Latar Belakang dan Masalah

**Proses As-Is (manual):**

1. Tarik file Fingerprint (.xlsx)
2. Tarik file HRIS (.xlsx)
3. Merge menjadi master data
4. Bersihkan data (duplikasi dan lainnya)
5. Hitung sesuai aturan perusahaan X
6. Hasilkan .xlsx final dengan performance (%)
7. Buat dashboard secara manual

**Masalah:** proses repetitif tiap periode, rawan human error, sulit ditelusuri ("kenapa 87%?"), dan dashboard dibuat ulang manual. Proyek ini berupa portofolio, sehingga baseline kuantitatif dari perusahaan nyata tidak tersedia dan seluruh pengujian memakai data dummy.

## 3. Tujuan dan Non-Tujuan

### Tujuan

- G1: Mengotomatisasi merge, cleaning, dan perhitungan attendance performance.
- G2: Memastikan tidak ada angka hasil tebakan sistem: kasus ambigu wajib diputuskan manusia dengan alasan tercatat.
- G3: Aturan perhitungan dapat diubah admin tanpa perubahan kode, dengan versioning dan log.
- G4: Menyediakan dashboard bulanan dan tren dari file hasil, tanpa penyimpanan data di server.
- G5: Menjaga privasi: tidak ada data karyawan yang persisten di platform.

### Non-Tujuan (di luar scope versi ini)

- Integrasi langsung ke mesin fingerprint atau HRIS. Ini pilihan desain, bukan constraint: pengguna cukup drag & drop file untuk mendapat file .xlsx final dan dashboard.
- Penyimpanan data karyawan atau data historis di server.
- Penggajian, bonus, atau keputusan SDM lainnya.
- Akses self-service untuk karyawan.

## 4. Pengguna dan Peran (RBAC)

| Role | Siapa | Hak akses |
| --- | --- | --- |
| **HR (User)** | Staf HR | Login, upload dan proses attendance, review exception, export, akses halaman Dashboard |
| **Admin** | Pengelola aturan | Login, kelola aturan di Admin Settings & Config. **Tidak** memproses atau melihat data karyawan |

**Prinsip:** platform bersifat private dan internal only; semua halaman memerlukan login. Login memakai email dummy karena ini proyek portofolio. Semua HR dapat melihat semua departemen; departemen ada sebagai kolom di file dan dipakai untuk pengelompokan di dashboard, bukan pembatasan akses.

## 5. Alur Proses To-Be

### Halaman 1: Proses Attendance

1. User menarik file Fingerprint dan HRIS (.xlsx) secara manual.
2. User login dan mengunggah kedua file.
3. **Validasi input**: format file, kolom wajib, ID yang tidak cocok. Error report ditampilkan sebelum lanjut.
4. Platform melakukan merge, cleaning, dan perhitungan memakai rule aktif (versi rule dicatat).
5. **Review exception**: setiap kasus yang di-flag diputuskan user (accept / override / exclude) dengan alasan wajib.
6. **Preview hasil**: ringkasan dan 10 data pertama, lalu approval (checkbox konfirmasi).
7. Export .xlsx final.
8. Sesi berakhir dan seluruh data dihapus.

### Halaman 2: Dashboard

1. User login dan mengunggah file .xlsx final hasil platform.
2. 1 file = dashboard satu bulan. 2 file atau lebih = dashboard tren.
3. Sesi berakhir dan data dihapus.

### Halaman 3: Admin Settings & Config

Admin mengelola aturan perhitungan lewat halaman Config: menambah, mengubah, dan menghapus aturan, dengan versioning dan log perubahan.

## 6. Kebutuhan Fungsional

### 6.1 Autentikasi dan Akses

- **FR-01** Semua halaman memerlukan login (email dummy); tanpa login tidak ada akses ke fungsi apa pun.
- **FR-02** Role Admin hanya dapat mengakses Admin Settings & Config; role HR tidak dapat mengakses halaman tersebut, dan Admin tidak dapat mengunggah atau melihat data karyawan.
- **FR-03** Session timeout 3 jam, dengan peringatan sebelum sesi berakhir.

### 6.2 Upload dan Validasi

- **FR-04** Menerima dua file .xlsx (Fingerprint dan HRIS) pada Halaman 1.
- **FR-05** Validasi struktur: kolom wajib ada (termasuk departemen), tipe data benar, format tanggal/jam terbaca.
- **FR-06** Validasi join key: ID karyawan yang ada di satu sumber tetapi tidak di sumber lain dilaporkan.
- **FR-07** Error report bersifat spesifik dan terbaca (kolom/baris yang bermasalah dan penyebabnya). Proses tidak lanjut jika ada error struktural.
- **FR-08** Batas ukuran file sekitar 64 MB per file. Tidak ada batas jumlah baris; file yang terlalu berat ditolak dengan pesan error yang jelas, dan proses memiliki batas waktu (timeout) agar tidak hang.

### 6.3 Merge, Cleaning, dan Perhitungan

- **FR-09** Merge kedua sumber berdasarkan ID karyawan; ID di Fingerprint dan HRIS sama.
- **FR-10** Cleaning minimal: duplikasi tap, normalisasi format, penanganan shift lintas hari.
- **FR-11** Perhitungan persentase memakai aturan aktif yang dikelola di Config. Karena belum ada aturan perusahaan nyata, disiapkan satu set aturan contoh untuk demo (toleransi keterlambatan, shift malam lintas hari, perlakuan cuti/izin/sakit).
- **FR-12** Versi rule yang dipakai dicatat dan dicantumkan di output.

### 6.4 Fail-Safe Flagging (prinsip: sistem tidak menebak)

- **FR-13** Jika sistem tidak dapat memutuskan dengan pasti, kasus **wajib di-flag**; tidak ada default diam-diam (misalnya otomatis dihitung hadir atau alpa).
- **FR-14** Kasus ber-flag berstatus "belum ditentukan" sampai diputuskan manusia.
- **FR-15** Tombol export **terkunci** selama masih ada flag yang belum diputuskan.
- **FR-16** Setiap flag menampilkan alasan yang terbaca, contoh: "Tap pulang tidak ditemukan pada 12 Mar, shift malam".
- **FR-17** Flag memiliki severity (kritis / informatif) dan dapat diurutkan dan difilter.
- **FR-18** Bulk action untuk flag sejenis diperbolehkan, tetapi alasan tetap wajib diisi.
- **FR-19** Jika proporsi flag melebihi ambang batas, sistem menampilkan peringatan kualitas data input dan menyarankan pemeriksaan file sumber. Ambang batas berupa setelan di Config, dengan nilai awal yang ditentukan Admin.

**Kategori flag awal:**

| Kategori | Contoh |
| --- | --- |
| Data tidak lengkap | Tap masuk tanpa tap pulang (atau sebaliknya), atau karyawan tanpa departemen |
| Data tidak cocok | ID ada di fingerprint tetapi tidak di HRIS |
| Data ambigu | Tap ganda dengan selisih tidak wajar, tap di luar jam shift |
| Tidak ada rule yang cocok | Kombinasi shift, departemen, dan status yang belum dicover rule |
| Konflik antar sumber | Fingerprint menunjukkan hadir, HRIS menunjukkan cuti |
| Nilai di luar batas wajar | Durasi kerja tidak masuk akal, atau 0% padahal ada tap |

### 6.5 Review, Preview, dan Approval (Human in the Loop)

- **FR-20** Setiap flag diputuskan dengan salah satu aksi: **accept**, **override**, atau **exclude**, dengan alasan wajib.
- **FR-21** Preview hasil menampilkan 10 data pertama sebagai pemeriksaan format.
- **FR-22** Preview dilengkapi **panel ringkasan**: total karyawan, jumlah flag dan statusnya, rata-rata %, nilai min dan max. Tujuannya mendeteksi kesalahan yang tidak ter-flag (sistem yakin tetapi salah).
- **FR-23** Checkbox konfirmasi wajib dicentang sebelum export aktif.
- **FR-24** Simpan draft review ke file lokal ditunda ke fase berikutnya (bukan MVP).

### 6.6 Export

- **FR-25** Export .xlsx final berisi sheet: **Hasil** (performance %), **Exception** (kasus, keputusan, alasan), **Audit Trail** (versi rule dan snapshot isi aturan yang dipakai, periode, waktu proses), dan **Metadata** (versi skema, periode, versi rule).
- **FR-26** File mengandung tanda integritas (checksum) agar perubahan manual dapat terdeteksi di Dashboard.
- **FR-27** Setelah export dan sesi berakhir, tidak ada data karyawan yang tersisa di server.

### 6.7 Dashboard (Halaman 2)

- **FR-28** Hanya menerima file .xlsx yang dihasilkan platform (divalidasi lewat metadata dan skema).
- **FR-29** 1 file: dashboard bulanan (distribusi %, rata-rata, tertinggi/terendah, ringkasan exception, pengelompokan per departemen).
- **FR-30** 2 file atau lebih: dashboard tren lintas periode. Batas maksimum 12 file. ⚠️ Angka batas dapat disesuaikan.
- **FR-31** Peringatan jika periode yang dibandingkan memakai **versi rule berbeda** (perbandingan tidak apple-to-apple), dengan menampilkan perbedaan isi aturan dari snapshot di file.
- **FR-32** Peringatan jika file terdeteksi diubah setelah export (checksum tidak cocok).
- **FR-33** Perilaku edge case: bulan bolong ditampilkan sebagai gap, dua file untuk periode yang sama ditolak dengan pesan jelas, karyawan baru/resign ditampilkan hanya pada periode yang relevan.
- **FR-34** Dashboard dapat diexport (PDF/HTML) karena tidak disimpan di server.

### 6.8 Admin Settings & Config (Halaman 3)

- **FR-35** Halaman Config memungkinkan Admin menambah, mengubah, dan menghapus aturan perhitungan (toleransi, jam shift, perlakuan status kehadiran, dll).
- **FR-36** Setiap perubahan aturan membuat **versi baru** dan tercatat di log: siapa, kapan, apa yang berubah.
- **FR-37** Aturan tidak berlaku surut; versi lama tetap dapat dirujuk. Penghapusan aturan bersifat permanen, dengan konfirmasi sebelum hapus dan tercatat di log perubahan (siapa, kapan, aturan apa). Penelusuran file lama dijamin oleh snapshot aturan di file hasil (FR-25).
- **FR-38** Admin tidak memiliki akses ke data karyawan yang diproses HR.
- **FR-39** Fleksibilitas aturan dibatasi pada parameter terstruktur, bukan bahasa pemrograman bebas. ⚠️ Batasan rinci ditentukan saat set aturan contoh disusun.

## 7. Kebutuhan Non-Fungsional

- **Privasi dan keamanan:** data karyawan hanya diproses di sesi dan tidak disimpan setelah merge selesai; server log, temp file, dan cache tidak boleh memuat PII; HTTPS. Klaim yang tepat: *"platform tidak menyimpan data karyawan"*; aturan dan log perubahan tetap tersimpan.
- **Kepatuhan:** proyek portofolio dengan data dummy. Jika dipakai di perusahaan nyata, perlu tinjauan UU PDP oleh legal/IT.
- **Sesi:** session timeout 3 jam dengan peringatan.
- **Performa:** ukuran file maksimum sekitar 64 MB. ⚠️ Target waktu proses ditentukan kemudian.
- **Keterlacakan:** setiap angka di hasil dapat ditelusuri ke aturan dan keputusan review yang tercatat di file.
- **Ketahanan:** pesan error spesifik, tidak ada kegagalan diam-diam.

## 8. Metrik Keberhasilan

Proyek portofolio tidak punya baseline dari perusahaan nyata, jadi keberhasilan diukur pada dataset dummy yang sengaja memuat kasus sulit (tap pulang hilang, shift malam, tap ganda, ID tidak cocok, konflik cuti). ⚠️ Usulan, belum dikonfirmasi.

| Metrik | Cara ukur di demo |
| --- | --- |
| Kasus sulit pada data dummy yang ter-flag | Semua kasus yang sengaja disisipkan ter-flag; tidak ada yang dihitung diam-diam |
| Export terkunci selama flag belum diputuskan | Tombol export nonaktif sampai semua flag diputuskan |
| Keterlacakan angka | Setiap persentase dapat ditelusuri lewat sheet Audit Trail ke aturan dan keputusan review |
| Waktu proses file dummy | Dicatat saat demo |

## 9. Risiko dan Mitigasi

| Risiko | Mitigasi |
| --- | --- |
| Format file sumber berubah atau tidak konsisten | Validasi ketat, error report spesifik, versi skema |
| Terlalu banyak flag sehingga user "accept semua" | Severity, bulk action dengan alasan wajib, ambang peringatan |
| Rule salah di-set admin sehingga hasil salah tanpa flag | Versioning, log perubahan, panel ringkasan sebagai cek |
| File hasil diedit manual lalu masuk dashboard | Checksum dan peringatan integritas |
| Sesi habis saat review | Session timeout 3 jam dengan peringatan; simpan draft ditunda ke fase berikutnya |
| Perbandingan tren memakai rule berbeda | Peringatan versi rule antar periode |
| Keberatan IT/legal soal data pribadi (jika dipakai di perusahaan nyata) | Desain stateless, audit PII pada log/cache, review UU PDP |
| Dipersepsikan setara template Excel | Rumuskan diferensiasi: rule engine, fail-safe flagging, audit trail, dashboard tren |

## 10. Rencana Bertahap

- **Fase 1 (MVP):** login + RBAC (HR dan Admin), upload dan validasi, merge/clean/hitung, flagging dan review exception, preview dan approval, export .xlsx dengan audit trail, halaman Admin Settings & Config dengan versioning.
- **Fase 2:** Dashboard bulanan dan tren dengan validasi integritas file.
- **Kandidat berikutnya:** simpan draft review ke file lokal, peningkatan rule engine, scoping per departemen, ekspor dashboard lanjutan. Integrasi langsung tidak masuk scope.

## 11. Keputusan dan Pertanyaan Tersisa

| Topik | Keputusan | Status |
| --- | --- | --- |
| Pembeda dari Excel/macro | Fail-safe flagging dengan export terkunci, audit trail di file, dan Config tanpa kode (bukan sekadar drag & drop) | Diputuskan |
| Aturan perhitungan | Belum ada aturan nyata; dikelola lewat halaman Config (tambah, edit, hapus) | Diputuskan |
| Hapus aturan di Config | Hapus permanen dengan konfirmasi dan tercatat di log; snapshot aturan tertanam di file hasil | Diputuskan |
| Baseline | Tidak berlaku; proyek portofolio dengan data dummy | Diputuskan |
| Autentikasi | Login dengan email dummy | Diputuskan |
| Integrasi langsung | Tidak diadakan; pilihan desain | Diputuskan |
| Pengguna | HR memproses data; Admin hanya mengatur Settings & Config | Diputuskan |
| ID karyawan | ID Fingerprint sama dengan HRIS | Diputuskan |
| Departemen | Kolom wajib di file; semua HR melihat semua departemen; dipakai untuk pengelompokan dashboard | Diputuskan |
| Session dan file | Session timeout 3 jam; file tidak disimpan setelah merge; batas ukuran sekitar 64 MB | Diputuskan |
| Batas jumlah baris | Tidak ada; file terlalu berat ditolak dengan pesan jelas, ada timeout proses | Diputuskan |
| Ambang proporsi flag | Setelan di Config; nilai awal ditentukan Admin | Diputuskan |
| Simpan draft review | Ditunda ke fase berikutnya | Diputuskan |
| Isi set aturan contoh dan dataset dummy dengan kasus sulit | Belum disusun | Terbuka |
