# Ako spustiť appku na internete (návod krok za krokom)

Celé to zaberie asi 10 minút. Najlepšie na počítači. Rob kroky po poradí.

---

## Krok 1: Zapnúť GitHub Pages (appka dostane adresu na internete)

1. Otvor stránku **https://github.com/tomaskoval-droid/ebike-trasy** a prihlás sa do GitHubu, ak treba.
2. Hore pod názvom repozitára je rad záložiek (Code, Issues, Pull requests…). Úplne vpravo klikni na **⚙ Settings**.
   - Ak Settings nevidíš, okno je úzke: klikni na **…** vpravo v tom rade a Settings bude tam.
3. V ľavom stĺpci nájdi časť **Code and automation** a klikni na **Pages**.
4. V časti **Build and deployment**:
   - **Source**: nechaj **Deploy from a branch**.
   - **Branch**: klikni na tlačidlo **None** a vyber **main**. Vedľa sa objaví druhé tlačidlo, nechaj na ňom **/ (root)**.
   - Klikni **Save**.
5. Počkaj 1 až 3 minúty a obnov stránku (F5). Hore sa objaví rámček **„Your site is live at https://tomaskoval-droid.github.io/ebike-trasy/“**.
6. Klikni na **Visit site**. Appka sa otvorí. Mapa ešte nebude fungovať, kým nespravíš Krok 3.

---

## Krok 2: Nastaviť Supabase (aby fungovali účty a potvrdzovací e-mail)

1. Otvor **https://supabase.com/dashboard** a prihlás sa.
2. Klikni na svoj projekt (ten, ktorý si zakladala pre appku).

### 2a: Adresa appky
3. V ľavom úzkom paneli klikni na ikonu **Authentication** (ikonka postavičky / zámku). Keď prejdeš myšou po ikonách, zobrazia sa názvy.
4. V menu Authentication klikni na **URL Configuration** (býva v časti Configuration).
5. Do poľa **Site URL** zmaž, čo tam je (zvyčajne `http://localhost:3000`), a vlož:
   `https://tomaskoval-droid.github.io/ebike-trasy/`
   Klikni **Save** pod poľom.
6. Nižšie v časti **Redirect URLs** klikni **Add URL**, vlož tú istú adresu
   `https://tomaskoval-droid.github.io/ebike-trasy/`
   a klikni **Save URLs**.

### 2b: Doplnenie databázy (ak si to ešte nespravila)
7. V ľavom paneli klikni na **SQL Editor** (ikonka `>_`).
8. Hore klikni na **+** alebo **New query**.
9. Skopíruj text príkazov:
   - **a)** Otvor si v prehliadači **novú kartu** (Ctrl+T, v mobile tlačidlo so štvorčekom → +).
   - **b)** Do riadku s adresou hore vlož túto adresu a stlač Enter:
     `https://raw.githubusercontent.com/tomaskoval-droid/ebike-trasy/main/supabase-update.sql`
   - **c)** Otvorí sa biela stránka s textom. Prvý riadok začína `-- Ebike Trasy: doplnenie databázy…`. Na tejto stránke nič neklikaj ani nepíš.
   - **d)** Klikni raz kamkoľvek do textu, aby bola stránka aktívna.
   - **e)** Stlač **Ctrl+A** (podrž Ctrl a stlač A). Celý text sa zafarbí na modro, teda je označený.
   - **f)** Stlač **Ctrl+C**. Text je skopírovaný, nič viditeľné sa nestane, to je v poriadku.
   - **g)** Vráť sa na kartu so Supabase (kliknutím na jej záložku hore v prehliadači).
   - **h)** Klikni do veľkého prázdneho okna editora (miesto, kde sa píše text, väčšinou s číslom riadku 1 vľavo). Ak v ňom už nejaký text je, stlač Ctrl+A a Delete, aby bolo prázdne.
   - **i)** Stlač **Ctrl+V**. Vloží sa celý text, približne 30 riadkov. Posledný riadok je `grant select, insert, update on public.user_settings to authenticated;`
   - Na Macu namiesto Ctrl použi Cmd (⌘).
10. Vpravo dole klikni **Run** (alebo Ctrl+Enter). Dole by sa malo objaviť **Success. No rows returned**. To je v poriadku, znamená to, že sa všetko pridalo.
   - Ak sa objaví okno s upozornením (napr. „Potential issue detected“ alebo „destructive operation“), klikni **Run this query** / **Confirm**. Príkazy nič nemažú, dajú sa spustiť aj viackrát.
   - Ak sa objaví červený text s chybou, odfoť ho a pošli mi ho.

---

## Krok 3: Kľúč Mapy.com priamo v appke (aby ľudia nemuseli mať vlastný)

### 3a: Obmedziť kľúč na adresu appky
1. Otvor **https://developer.mapy.com** a prihlás sa.
2. Choď do svojho projektu a sekcie s **API kľúčmi** (API keys).
3. Pri svojom kľúči klikni na úpravu (ceruzka alebo názov kľúča).
4. Nájdi nastavenie povolených domén / referrerov (**Allowed domains**, **HTTP referrer** alebo podobne) a pridaj:
   `tomaskoval-droid.github.io`
   Ak tam už nejaké domény sú, nechaj ich a túto len pridaj. Ulož.
5. Skopíruj si celý kľúč (dlhý reťazec písmen a čísel).

### 3b: Vložiť kľúč do appky na GitHube
6. Otvor **https://github.com/tomaskoval-droid/ebike-trasy/blob/main/app.js**
7. Vpravo hore nad textom súboru klikni na ikonu **ceruzky ✏** (Edit this file).
8. Na **7. riadku** je:
   `const APP_MAPY_KEY = '';`
   Klikni presne medzi dva apostrofy `''` a vlož kľúč (Ctrl+V). Má to vyzerať takto:
   `const APP_MAPY_KEY = 'TVOJ-KLUC';`
   Apostrofy musia zostať na oboch stranách. Nič iné v súbore nemeň.
9. Vpravo hore klikni zelené **Commit changes…**, v okne ešte raz **Commit changes**.
10. Počkaj 1 až 2 minúty a otvor appku: **https://tomaskoval-droid.github.io/ebike-trasy/**
    Ak sa mapa neukáže, stlač **Ctrl+Shift+R** (obnovenie bez starej pamäte). V mobile zatvor a znova otvor prehliadač.

Kľúč nepíš do chatu. V appke na internete bude aj tak viditeľný, preto je dôležité obmedzenie z kroku 3a: nikto iný ho nebude môcť použiť na inej stránke.

---

## Hotovo, čo vyskúšať
- Naplánuj trasu z A do B a jeden okruh.
- Zaregistruj sa a potvrď e-mail (odkaz z e-mailu má otvoriť appku).
- Ulož trasu a otvor appku v mobile, trasa tam má byť tiež.
- V mobile v prehliadači daj **Pridať na plochu** / **Inštalovať aplikáciu**.

Ak niečo nepôjde, odfoť obrazovku a pošli mi ju.
