# Tenflow: Panduan Pengguna (ringkas)

Aplikasi ini mengolah data **Fingerprint** dan **HRIS (Talenta)** menjadi laporan attendance dan kepatuhan WFO. Data hanya ada di browser selama sesi dan dihapus saat sesi berakhir (maks. 3 jam).

## 1. Peran

| Peran | Bisa | Akun demo |
|---|---|---|
| **HR** | Proses Attendance, Dashboard | `hr@tenflow.demo` |
| **Admin** | Semua fitur HR + **Settings & Config** | `admin@tenflow.demo` |

## 2. Alur kerja HR

1. **Upload & validasi.** Unggah file Fingerprint dan HRIS (.xlsx, maks. 64 MB). Perbaiki semua *error* (merah) lalu unggah ulang. *Peringatan* (kuning) hanya informasi.
2. **Review exception.** Putuskan setiap flag: **Accept** (pakai hasil sistem), **Override** (tentukan hasil hari secara manual) atau **Exclude** (keluarkan dari perhitungan). Alasan wajib. Pilih beberapa flag sejenis untuk keputusan massal.
3. **Evaluasi & WFO.** Periksa ringkasan, daftar harian, kepatuhan WFO, shift, dan kualitas data (lihat bagian 4).
4. **Pratinjau & approval.** Periksa 10 baris pertama dan panel ringkasan, centang konfirmasi.
5. **Export.** Tombol export terkunci selama masih ada flag yang belum diputuskan. Hasilnya file .xlsx berisi sheet Final Data, Master Data, Exception, Audit Trail, Metadata, **Daily Evaluation**, dan **WFO Compliance**.

Selesai? Klik **Akhiri sesi data** agar data karyawan terhapus.

### Format file

| File | Kolom wajib | Kolom opsional |
|---|---|---|
| Fingerprint | Employee ID, Organization, Tanggal, Waktu, Status (C/Masuk, C/Keluar) | Full Name, Kategori |
| HRIS | Employee ID, Full Name, Organization, Date, Shift, Schedule In, Schedule Out, Attendance Code | Check In, Check Out, Line Manager, Approval Status, Leave Period (Full/AM/PM), Leave Start, Leave End, Work Location (WFH/WFO) |

Kolom opsional yang tidak ada dianggap **tidak diketahui**: tidak pernah dibaca sebagai disetujui, setengah hari, atau WFH. Satu file = satu bulan.

## 3. Flag: apa yang di-flag dan cara memutuskan

| Flag | Penyebab | Saran keputusan |
|---|---|---|
| Tap pulang / masuk tidak ditemukan | Hanya ada satu tap dan Talenta tidak bisa melengkapi | Pakai template alasan (di bawah) |
| Konflik cuti vs fingerprint | Kode cuti/sakit di HRIS tetapi tap tidak menutup seluruh shift dan bukan pola cuti setengah hari ALR; atau tap di dalam periode cuti | Cuti setengah hari: Override *Patuh* + template. Salah kode: Accept |
| Durasi di luar batas wajar | Selisih tap pertama–terakhir < 60 atau > 960 menit | Override atau Exclude |
| Shift / kode kehadiran tanpa rule | Shift atau kode belum dipetakan di Config | Minta Admin menambah rule, proses ulang |
| Kategori fingerprint ≠ jadwal HRIS | Kolom Kategori tidak cocok dengan shift hari itu | Konfirmasi ke HR Operations |
| Status tap tidak dikenal, HRIS ganda berbeda, tap tanpa jadwal HRIS, ID hanya di Fingerprint, karyawan tanpa departemen | Data sumber bermasalah | Perbaiki sumber atau putuskan satu per satu |

**Template alasan** (di dialog keputusan): *Meeting/dinas luar*, *Cuti setengah hari (1 ALR = 2 setengah hari)*, *Sakit setengah hari*, *Lupa tap, dikonfirmasi atasan*, *Data tidak valid*. Template hanya mengisi form; **lengkapi alasan** (siapa yang mengonfirmasi, jam) sebelum menyimpan.

**Tidak di-flag:** tap ganda atau urutan tap tidak berpasangan atau tap di luar jam shift (jam masuk = tap paling awal, jam pulang = tap paling akhir); tap di hari libur (dianggap tidak ada); ID yang hanya ada di HRIS (dinilai dari data HRIS); hari satu tap yang jam lainnya ada di Check In/Out Talenta.

## 4. Layar Evaluasi & WFO

| Tab | Isi |
|---|---|
| **Ringkasan** | Hadir fisik, WFH, kepatuhan WFO, terlambat/pulang awal, tap hilang, hari perlu review; per departemen; definisi metrik |
| **Harian** | Satu baris per karyawan per hari + filter. Klik panah di ujung baris untuk "Mengapa status ini?" (dasar penilaian, bukti tap, sumber data). Cari satu ID untuk melihat riwayatnya |
| **Kepatuhan WFO** | Per karyawan: terjadwal, cuti disetujui, WFH, WFO fisik, wajib, terkredit, status. Panah = rincian per minggu |
| **Shift & jadwal** | Hari, terlambat, pulang awal per shift |
| **Kualitas data** | Tap duplikat, tap hilang, tap dilengkapi Talenta, hari menunggu keputusan, daftar hari perlu review |

**Status kepatuhan:** *Patuh*; *Tidak patuh* (selisih tetap ada walau semua hari yang belum pasti berpihak ke karyawan); *Perlu review HR* (belum bisa dipastikan, **bukan pelanggaran**); *Tanpa kewajiban*.

**Rumus WFO:** wajib per minggu = maks(0, min(4, hari terjadwal − cuti disetujui − 1 jatah WFH)). Terkredit = min(WFO fisik, wajib). Kepatuhan = Σ terkredit ÷ Σ wajib. WFH tidak pernah dihitung sebagai WFO; tidak ada fingerprint bukan bukti absen.

## 5. Dashboard

Unggah satu file hasil Tenflow untuk dashboard bulanan, dua file atau lebih (maks. 12, satu per bulan) untuk tren. Peringatan muncul bila file diubah setelah export (checksum), atau bila periode memakai versi rule berbeda. File lama tanpa sheet evaluasi tetap terbaca (tanpa bagian WFO). **Cetak / simpan PDF** untuk mengekspor tampilan.

## 6. Settings & Config (Admin)

Setiap perubahan **membuat versi rule baru** dan tercatat di **Log perubahan** (siapa, kapan, apa). Versi lama bisa dilihat (hanya baca) lewat pilihan *Versi rule*, tidak berlaku surut, dan snapshot-nya tertanam di setiap file hasil. Hapus bersifat permanen dengan konfirmasi. Rule disimpan di browser ini saja (bukan server), jadi tidak dibagikan antar komputer.

Enam tab: **Parameter**, **Work Schedule**, **Pemetaan shift**, **Kode kehadiran**, **Divisi fleksibel**, **Log perubahan**.

### 6.1 Parameter

Tanda ⚠ = interpretasi dokumen edge case yang **perlu dikonfirmasi HR**. Nilai 0/1 = mati/hidup.

**Jadwal dan keterlambatan**

| Parameter | Awal | Fungsi |
|---|---|---|
| ⚠ Dasar jadwal | 1 | 1 = nilai terlambat/pulang awal dari **jam shift HRIS hari itu**. 0 = ambang Work Schedule per karyawan (rumus sheet perusahaan) |
| ⚠ Toleransi terlambat | 15 mnt | Terlambat bila tap masuk > Schedule In + nilai ini (dasar 1) |
| Toleransi pulang awal | 0 mnt | Pulang awal bila tap pulang < Schedule Out − nilai ini (dasar 1) |
| Batas tap pulang shift lintas hari | 360 mnt | Tap pulang esok hari hingga batas ini setelah Schedule Out dihitung milik shift malam |
| Jendela duplikasi tap | 5 mnt | Tap sejenis dalam jendela ini digabung jadi satu (tetap tercatat sebagai bukti) |

**Tap, hari libur, dan kelengkapan**

| Parameter | Awal | Fungsi |
|---|---|---|
| Tap di hari libur dianggap tidak ada | 1 | 1 = tap di hari dayoff/national holiday diabaikan. 0 = di-flag dan dihitung |
| Check In/Out Talenta melengkapi tap yang hilang | 1 | 1 = jam yang hilang diambil dari Talenta bila masuk akal; kehadiran fisik tetap dari fingerprint |
| Durasi kerja minimum / maksimum wajar | 60 / 960 mnt | Di luar rentang ini di-flag |
| Ambang proporsi flag | 10 % | Di atasnya muncul peringatan kualitas data input |

**Cuti dan WFH**

| Parameter | Awal | Fungsi |
|---|---|---|
| ⚠ Istirahat siang mulai / selesai | 720 / 780 (12:00 / 13:00) | Untuk cuti setengah hari **tanpa jam**: cuti pagi selesai jam akhir istirahat, cuti sore mulai jam awal istirahat. Satuan: menit sejak 00:00 |
| Toleransi tap di tepi periode cuti | 15 mnt | Tap sedekat ini dari tepi periode cuti bukan konflik |
| ⚠ ALR tanpa periode: simpulkan cuti setengah hari dari tap | 1 | HRIS berkode **ALR** tanpa periode, kedua tap ada, status bukan Pending/Rejected: masuk tepat waktu lalu pulang sebelum/saat istirahat siang (≤ akhir istirahat) = **cuti sore**; masuk setelah mulai istirahat siang lalu pulang tepat waktu = **cuti pagi**. Tanpa flag dan tidak dinilai terlambat/pulang awal. Selain itu tetap konflik cuti seharian. Tidak berlaku untuk shift lintas hari. 0 = ALR tanpa periode selalu cuti seharian |
| ⚠ HRIS Hadir (H) + tap sebelah saja = lupa tap | 1 | Hari berkode H di HRIS yang hanya punya tap masuk atau hanya tap pulang (dan tidak bisa dilengkapi Talenta): dianggap hadir, tanpa flag. Sisi yang kosong tidak dinilai terlambat/pulang awal; sisi yang ada tetap dinilai. Kode kosong atau kode lain tidak termasuk. 0 = di-flag |
| ⚠ Lupa tap pulang = Early Clock Out | 1 | Hari berkode H atau divisi fleksibel tanpa tap pulang tetap dianggap hadir tanpa flag, tetapi dihitung **Early Clock Out**. Tap masuk yang hilang tidak dinilai terlambat. Cuti sore/dinas disetujui tidak terkena. 0 = sisi yang hilang tidak dinilai |
| ⚠ Kode cuti + tap penuh seharian = hadir | 1 | HRIS berkode cuti/izin/sakit seharian (ALR, SLD, CL, dst.) tetapi tap pertama tidak terlambat dan tap terakhir tidak pulang awal: dianggap hadir menurut fingerprint, tanpa flag. Kode cuti tidak dinilai; dampak ke saldo cuti ada di luar aplikasi ini. 0 = selalu di-flag |
| ⚠ Cuti tanpa status persetujuan dianggap disetujui | 0 | 0 (disarankan) = pengecualian hanya bila status Approved ada. Ubah ke 1 hanya jika ekspor Talenta hanya memuat cuti yang sudah disetujui |
| ⚠ Catatan Talenta tanpa fingerprint = WFH | 1 | 1 = hari kerja dengan Check In Talenta tanpa tap dikategorikan WFH |
| Karyawan tanpa fingerprint: Check In Talenta = hadir di kantor | 1 | 1 = untuk karyawan tanpa satu pun tap, Check In Talenta dihitung WFO. WFH eksplisit dan cuti tetap berlaku |

**Kepatuhan WFO**

| Parameter | Awal | Fungsi |
|---|---|---|
| Hari WFO per minggu | 4 | Batas atas kewajiban mingguan |
| Jatah WFH per minggu | 1 | Dikurangkan dari hari tersedia |
| ⚠ Cuti menghabiskan jatah WFH dahulu | 0 | 1 = kewajiban = min(hari WFO, hari kerja − cuti), jatah WFH tidak dikurangi (lebih ketat) |
| ⚠ Ambang kepatuhan WFO | 100 % | Patuh bila terkredit ÷ wajib ≥ nilai ini |
| Ambang "Perlu Evaluasi" / "Late >…%" | 20 % / 20 % | Remarks pada Final Data |

Tombol **Simpan sebagai versi baru** aktif bila ada perubahan dan semua nilai valid. **Batalkan perubahan** mengembalikan form.

### 6.2 Work Schedule

Ambang jam per kategori (REGULER, SHIFTING, SHIFTING OB: terlambat jika masuk setelah X, pulang awal jika pulang sebelum Y; opsional jendela kedua untuk tap masuk yang lebih siang, dipakai SHIFTING OB). **Dipakai untuk nilai terlambat hanya bila Dasar jadwal = 0.** Dengan Dasar jadwal = 1, tab ini menentukan kategori saja. *Prioritas*: karyawan dengan beberapa shift memakai jadwal berprioritas tertinggi untuk kolom Work Schedule di Final Data.

### 6.3 Pemetaan shift

Menghubungkan kode kolom *Shift* di HRIS ke Work Schedule. Bawaan: `N` → REGULER; `S1, S1-SO, S2, S2-SO, S3, Shifting SO 1` → SHIFTING; `S1 OP, S2-OP` → SHIFTING OB. Shift baru yang belum dipetakan akan di-flag "tidak ada rule" saat proses. Tambahkan pemetaannya di sini lalu proses ulang.

### 6.4 Kode kehadiran

Menentukan arti kolom *Attendance Code*. Perlakuan:

| Perlakuan | Arti |
|---|---|
| Hadir | Hari kerja biasa (bawaan: `H`) |
| Cuti / izin / sakit | Tap pada hari ini di-flag konflik, kecuali cuti setengah hari disetujui yang konsisten dengan tap. Cuti seharian disetujui mengurangi kewajiban WFO. Bawaan: ALR (Annual Leave Reguler), ALE (Annual Leave Executive), CL, SLD, CM, CKA |
| WFH menurut Talenta | WFH eksplisit; tap pada hari itu di-flag konflik |
| Dinas / meeting luar kantor | Bila disetujui: tap sebelah tidak di-flag, tanpa fingerprint bukan WFO/WFH dan mengurangi kewajiban WFO. **Belum ada kode bawaan**: tambahkan kode Talenta-nya di sini |

Kode yang tidak ada di daftar (mis. `CIM`) di-flag "tidak ada rule" dan tidak memberi pengecualian apa pun.

### 6.5 Divisi fleksibel

Daftar divisi yang stafnya sering keluar-masuk kantor untuk meeting (bawaan: **COM**). Untuk karyawan divisi ini, pada hari kerja:

- tap sebelah saja (masuk saja atau pulang saja) dianggap **hadir**, tanpa flag, apa pun kode HRIS-nya (H atau kosong). Sisi yang kosong tidak dinilai;
- durasi tap pertama–terakhir yang tidak wajar tidak di-flag;
- terlambat/pulang awal tetap dinilai bila kedua tap ada, dan sisi yang ada tetap dinilai;
- hari berkode cuti, WFH atau dinas tetap mengikuti rule kodenya;
- hari tanpa satu pun tap (meeting seharian di luar) **tidak** otomatis hadir: tetap "tanpa bukti" kecuali Talenta/HRIS mencatatnya (misalnya kode dinas).

Nama dicocokkan dengan kolom Organization di HRIS; awalan perusahaan dalam kurung dan huruf besar/kecil diabaikan ("COM" cocok dengan "[AB] COM"). Perubahan daftar membuat versi rule baru dan tercatat di log. Perlu konfirmasi HR.

### 6.6 Praktik yang disarankan

- Ubah **satu hal per perubahan** supaya Log perubahan mudah dibaca.
- Setelah mengubah rule, **proses ulang** data. Hasil lama tidak berubah.
- Bandingkan angka bulan ini dengan bulan lalu hanya bila versi rule sama (Dashboard memperingatkan bila berbeda).
- Mengubah ⚠ parameter sebaiknya setelah HR mengonfirmasi kebijakannya.

## 7. Masalah umum

| Gejala | Penyebab / solusi |
|---|---|
| "Kolom wajib tidak ditemukan" | Nama kolom pada header tidak sesuai tabel di bagian 2 |
| "Isi file bukan format .xlsx" | File lain yang diganti nama; ekspor ulang sebagai .xlsx |
| HRIS memuat lebih dari satu periode | Unggah satu bulan per proses |
| Tombol export terkunci | Masih ada flag belum diputuskan atau konfirmasi belum dicentang |
| Banyak "Perlu review HR" | Normal sebelum flag diputuskan; atau status persetujuan cuti tidak ada di file (lihat parameter cuti) |
| Sesi habis | Data terhapus otomatis setelah 3 jam; ekspor sebelum itu |
