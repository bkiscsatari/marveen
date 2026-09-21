#!/usr/bin/env python3
"""Biztonsagos frontmatter-mezo iras a KOZOS memoria-tarba.

MIERT LETEZIK (2026-09-20): egy tomeges cimkezes a beolvasott allapotbol dolgozott, es
kozben egy masik agens ugyanabba a tarba irt. A "ha mar van ilyen mezo, hagyd ki"
feltetel a REGI szovegen futott, ezert a kiiras felulirta a masik agens 14 cimkejet.
A tar ot agens szamara elerheto (mind a .claude-config/projects symlinkjen at), tehat
ez nem kivetel, hanem az alapeset.

A VEDELEM: minden fajlt KOZVETLENUL az iras elott olvasunk ujra, es
  - ha kozben megjelent a mezo -> KIHAGYJUK (a masike a nyertes, nem a mienk)
  - ha kozben barmi MAS valtozott -> KIHAGYJUK es jelentjuk (nem irunk ra)
A kimenet MINDEN agon darabszamot ad, a zolden is: irt / kihagyott-mezo /
kihagyott-valtozott / hiba. A nulla vizsgalt egyseg BUKAS (exit 2), nem zold.
"""
import hashlib, os, re, sys

def md5(b): return hashlib.md5(b).hexdigest()

def census(mappa, field):
    """A mezo ERTEKEINEK eloszlasa -- iras ELOTT es UTAN is lefut.
    Argus 2006/5.: a tomeges iras utan kotelezo a visszameres. Nem az szamit, hogy
    hany sort irtunk, hanem hogy MAS agens cimkeje nem tunt-e el kozben."""
    import collections
    c = collections.Counter()
    for f in sorted(x for x in os.listdir(mappa) if x.endswith('.md') and x != 'MEMORY.md'):
        t = open(os.path.join(mappa, f), encoding='utf-8').read()
        # KET HELYEN allhat: felso szinten VAGY a metadata blokkban behuzva.
        # 2026-09-20: a census csak a felso szintut kereste, ezert ket, valojaban
        # cimkezett fajlt '(nincs)'-kent jelentett -- ugyanaz a mezonev, ket hely.
        m = re.search(rf'^{re.escape(field)}:\s*(\S+)', t, re.M)
        m2 = re.search(rf'^[ \t]+{re.escape(field)}:\s*(\S+)', t, re.M)
        if m: c[m.group(1)] += 1
        elif m2: c[m2.group(1) + ' (metadata alatt)'] += 1
        else: c['(nincs)'] += 1
    return c


def set_field(path, field, value, comment=None, _teszt_hook=None, csere=False):
    """-> ('irt'|'van-mar'|'valtozott'|'nincs-horgony', reszlet)

    A _teszt_hook KIZAROLAG a tores-probahoz van: a ket olvasas KOZOTT hivodik meg,
    hogy a versenyhelyzet determinisztikusan eloallithato legyen. Enelkul a vedo ag
    nem bizonyithato, es egy soha meg nem szolalo feltetel semmit nem er.
    """
    with open(path, 'rb') as fh: elso = fh.read()
    t = elso.decode('utf-8')
    meglevo = re.search(rf'^{re.escape(field)}:.*$', t, re.M)
    sor_ertek = f"{field}: {value}" + (f"   # {comment}" if comment else "")
    if meglevo and not csere: return ('van-mar', meglevo.group(0))
    if meglevo:
        regi = meglevo.group(0)
        if regi == sor_ertek: return ('van-mar', regi)
        uj = t[:meglevo.start()] + sor_ertek + t[meglevo.end():]
    else:
        m = re.search(r'^name:.*$', t, re.M)
        if not m: return ('nincs-horgony', 'nincs name: sor')
        uj = t[:m.end()] + "\n" + sor_ertek + t[m.end():]
    if _teszt_hook: _teszt_hook(path)
    # UJRAOLVASAS kozvetlenul az iras elott -- ez a vedelem lenyege
    with open(path, 'rb') as fh: masodik = fh.read()
    if md5(masodik) != md5(elso):
        t2 = masodik.decode('utf-8', 'replace')
        return ('valtozott', 'kozben mezot kapott' if re.search(rf'^{re.escape(field)}:', t2, re.M) else 'kozben modosult')
    with open(path, 'w', encoding='utf-8') as fh: fh.write(uj)
    return ('irt', None)


def append_line(path, sor, probak=5, _teszt_hook=None):
    """Sor HOZZAFUZESE egy index-fajlhoz, versenyhelyzetben is (Brix 2066/4b).

    A set_field() vedelme a KIHAGYAS: mezo-irasnal ez helyes, mert a masik iro
    erteke a nyertes, es a mienk felesleges. INDEX-hez fuzesnel viszont a kihagyas
    ADATVESZTES -- a sor egyszeruen nem kerul be, es semmi nem szol rola.
    Ezert itt UJRAPROBALAS kell: ujraolvas, es a FRISS tartalomhoz fuz.
    """
    import time
    for k in range(probak):
        with open(path, 'rb') as fh: elso = fh.read()
        t = elso.decode('utf-8')
        if sor.strip() and sor.strip() in t: return ('van-mar', k)
        uj = t if t.endswith('\n') or not t else t + '\n'
        uj = uj + sor + ('' if sor.endswith('\n') else '\n')
        if _teszt_hook: _teszt_hook(path, k)
        with open(path, 'rb') as fh: masodik = fh.read()
        if md5(masodik) != md5(elso):
            time.sleep(0.01)
            continue          # UJRA, nem kihagyas
        with open(path, 'w', encoding='utf-8') as fh: fh.write(uj)
        return ('fuzve', k)
    return ('feladtam', probak)


def main(argv):
    if len(argv) < 4:
        print("hasznalat: memoria-mezo-iras.py [--csere] <mappa> <mezo> <ertek> [fajl ...]"); return 2
    csere = '--csere' in argv
    argv = [a for a in argv if a != '--csere']
    mappa, mezo, ertek = argv[1], argv[2], argv[3]
    elotte = census(mappa, mezo)
    fajlok = argv[4:] or sorted(f for f in os.listdir(mappa) if f.endswith('.md') and f != 'MEMORY.md')
    if not fajlok:
        print("BUKAS: 0 fajlt vizsgaltam -- a nulla egyseg nem zold eredmeny"); return 2
    # A SZAMOK ELE A SAJAT BEMENETEK (Argus 2079/2., Brix 2077/2.): a kimasolt sor
    # vigye a receptet, ne az emlekezet. Enelkul a "vizsgalt: 19" szam nem mondja meg,
    # MELYIK mappan, MELYIK mezore es MILYEN modban keszult.
    import hashlib as _h
    _lista = _h.md5('\n'.join(sorted(fajlok)).encode()).hexdigest()[:12]
    print(f"[mappa={mappa} | mezo={mezo} | ertek={ertek} | mod={'csere' if csere else 'set-ha-nincs'} "
          f"| fajl={len(fajlok)} | fajllista-md5={_lista}]")
    szamlalo = {'irt': 0, 'van-mar': 0, 'valtozott': 0, 'nincs-horgony': 0}
    reszletek = []
    for f in fajlok:
        allapot, reszlet = set_field(os.path.join(mappa, f), mezo, ertek, csere=csere)
        szamlalo[allapot] += 1
        if allapot in ('valtozott', 'nincs-horgony'): reszletek.append(f"  {allapot}: {f} ({reszlet})")
    print(f"vizsgalt: {len(fajlok)} | irt: {szamlalo['irt']} | mar volt mezo: {szamlalo['van-mar']} | "
          f"KOZBEN VALTOZOTT (kihagyva): {szamlalo['valtozott']} | horgony nelkul: {szamlalo['nincs-horgony']}")
    for r in reszletek: print(r)
    utana = census(mappa, mezo)
    eltunt = {k: (elotte[k], utana[k]) for k in elotte if k not in (ertek, '(nincs)') and utana[k] < elotte[k]}
    print(f"cimke-eloszlas ELOTTE: {dict(elotte)}")
    print(f"cimke-eloszlas UTANA:  {dict(utana)}")
    if eltunt:
        print(f"FIGYELEM -- MAS cimke fogyott kozben (ezt nem mi irtuk felul szandekosan?): {eltunt}")
    return 1 if szamlalo['valtozott'] or szamlalo['nincs-horgony'] or eltunt else 0

if __name__ == '__main__': sys.exit(main(sys.argv))
