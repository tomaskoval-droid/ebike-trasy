# Ebike Trasy

Webová appka na plánovanie e-bike trás nad Mapy.com. Funguje na počítači aj v mobile, dá sa nainštalovať do mobilu ako appka.

## Spustenie
- Na internete: nahraj obsah tohto priečinka do GitHub repozitára a zapni GitHub Pages (Settings → Pages → Branch `main`).
- Doma zo súboru: otvor `index.html`, alebo radšej jednosúborovú verziu `ebike-trasy.html`.
- Kľúč Mapy.com: buď ho vloží každý používateľ v Nastaveniach, alebo ho dáš do `app.js` do `APP_MAPY_KEY` (na developer.mapy.com ho obmedz len na adresu appky).
- Účty: Supabase. Najprv spusti `supabase-setup.sql`, potom `supabase-update.sql` (poznámky k trasám, bicykle v účte).

## Čo vie
- Trasa z A do B s prejazdnými bodmi (poradie sa dá meniť), 4 až 6 variantov, okruhy na kilometre alebo na čas.
- Pri každom variante obtiažnosť, čas na e-biku, batéria v cieli a podiel cyklotrás.
- Výškový profil, povrch v % (OpenStreetMap), počasie a vietor na trase (Open-Meteo) s návrhom najlepšieho času.
- Viac bicyklov, odhad batérie, ktorý sa učí z tvojich jázd, automatický návrh nabíjania.
- Nabíjačky, kaviarne, voda, cykloservisy, vyhliadky a obchody pri trase.
- Fotky pri trase, vrstvy cyklo a MTB trás, odkaz na Strava heatmapu, odkazy na podobné trasy.
- Export GPX (Garmin Connect → Kurz), QR kód do mobilu, otvorenie v Mapy.com, uložené trasy s hodnotením, poznámkou a stavom.
- Úvodný sprievodca pri prvom otvorení, offline zobrazenie poslednej trasy.

Model spotreby batérie je v `app.js` v objekte `Energy` a dá sa doladiť.
