# Fobifiltr

Rozšíření pro Chrome, které ve videích na YouTube rozmaže pavouky, hady a další věci, kterých se bojíš. AI běží přímo v tvém prohlížeči, snímky z videa nikam neodcházejí.

Vzniklo, když se kamarád nemohl podívat na video, protože v něm byli pavouci.

## Co umí

- **Kategorie:** pavouci, hadi, hmyz a švábi, myši a krysy, shluky děr (trypofobie), klauni, jehly a injekce, krev a zranění, žraloci. Zapnout si můžeš libovolné, výchozí jsou pavouci a hadi.
- **Vlastní slova:** až 10 anglických slov (třeba `frog`, `bird`, `worm`), model CLIP rozumí jen angličtině.
- **Citlivost:** Nízká, Střední, Vysoká.
- **Přísný režim:** úsek videa zůstane rozmazaný, dokud ho AI neprověří.
- **Ztlumení zvuku** při skrytí a tlačítko **Ukázat**, které video na 10 sekund odkryje.
- Rozmazává i **náhledy videí na stránce** (doporučená videa, vyhledávání, hlavní stránka, konec videa) a náhledy nad posuvníkem.

## Instalace

1. Stáhni repozitář (Code → Download ZIP) a rozbal ho.
2. V Chromu otevři `chrome://extensions`, zapni **Režim pro vývojáře** a klikni na **Načíst rozbalené**. Vyber složku s rozšířením.
3. Při prvním spuštění se stáhne AI model (asi 115 MB z Hugging Face, bez grafiky 150 MB). Pak zůstane v mezipaměti prohlížeče a další start trvá pár sekund.

## Jak to funguje

AI je model [CLIP](https://github.com/openai/CLIP) (ViT-B/32), který běží přes [transformers.js](https://github.com/huggingface/transformers.js) a ONNX Runtime Web v neviditelné stránce rozšíření. Obrazová část jede na grafice přes WebGPU (váhy na 4 bity), a když WebGPU není, na procesoru (8 bitů). Textová část se počítá jen při změně slov, na procesoru. CLIP porovná obrázek s anglickými popisy („a photo of a spider“) a s asi 40 běžnými scénami (člověk, jídlo, auto, krab, lano…) a řekne, ke kterému popisu má obrázek nejblíž. Popisy jedné kategorie se zprůměrují do jednoho vektoru, takže kategorie s víc popisy nemá výhodu. Široký snímek se rozdělí na několik čtverců, aby pavouk u kraje nezůstal mimo.

Video hlídají dvě vrstvy:

1. **Skenování dopředu.** YouTube má ke každému videu storyboard, mřížku malých náhledů, které ukazuje nad posuvníkem. Fobifiltr je prochází od místa, kde zrovna jsi, takže o pavoukovi ví dřív, než přijde. Během reklamy skenuje taky, to je ideální čas.
2. **Živá kontrola.** Na grafice 4× za sekundu (na procesoru asi jednou) pošle AI aktuální snímek jako pojistku mezi náhledy.

Úlohy mají pořadí: živý snímek, pak nejbližších 30 s videa, pak náhledy na stránce, pak zbytek videa.

## Jak dobře to funguje

Měřeno na notebooku s integrovanou grafikou Intel Iris Xe:

| | grafika (WebGPU) | jen procesor |
|---|---|---|
| jeden snímek z videa | 50 až 90 ms | 0,4 až 0,6 s |
| storyboard 4min videa (121 náhledů) | pár sekund, obvykle hotový ještě během reklamy | asi 2 minuty |
| zahozené snímky videa v 1080p | 0 | |

Model se poprvé stahuje 20 až 60 s, z mezipaměti se načte za 2 až 4 s.

Přesnost na 150 ručně ověřených snímcích z 50 videí, citlivost Střední (grafika i procesor vychází stejně):

| | zachyceno | plané poplachy |
|---|---|---|
| pavouci | 15 z 15 | 2 ze 123 |
| hadi | 12 z 12 | 2 až 3 ze 132 |

Na storyboardech 17 běžných videí (vlogy, vaření, hry, hudba, sport, zprávy, 2268 náhledů) se na Střední označilo 6 náhledů, většinou u rybaření a zahrady. Sada je malá, ber čísla jako orientační. Typické chyby: malý krab na písku občas vyjde jako pavouk, zahradní hadice v ruce jako had, kůra stromu s dírou jako pavouk.

## Omezení

- CLIP není detektor objektů. Malý pavouk v rohu širokého záběru může proklouznout.
- Storyboard má nízké rozlišení, proto běží ještě živá kontrola.
- Bez WebGPU (starší grafika, vypnutá akcelerace) je všechno pomalejší a v přísném režimu bývá video déle rozmazané, než ho AI prověří.
- Chrome na Windows vždycky vezme úspornou grafiku (třeba Intel místo NVIDIA). I ta stačí.
- Jen YouTube. U Shorts běží jen živá kontrola.
- Je to studentský projekt, ne zdravotnická pomůcka. Nic nezaručuje, že se nic neobjeví.

## Soukromí

Snímky z videa ani nastavení neopouštějí počítač. Rozšíření stahuje jen AI model z huggingface.co (jednou) a náhledy videí z i.ytimg.com (ty prohlížeč stahuje i bez něj). Žádná analytika, žádný server.

Existují i placené služby, které video analyzují v cloudu (například unscene.it). Fobifiltr je naopak otevřený a celý běží u tebe.

## Co dál

- Víc menších výřezů na snímek, aby se chytil i malý pavouk v rohu (na grafice je na to výkon).
- Přesnější model (SigLIP nebo malý detektor objektů).
- Varování dopředu podle titulků a přepisu videa.
- Verze pro Firefox.
- Veřejná testovací sada a automatické měření přesnosti.

## Licence

Kód je pod licencí MIT (soubor `LICENSE`).

Třetí strany ve složce `vendor/`:

- transformers.js, Apache-2.0 (`vendor/LICENSE-transformers.txt`)
- ONNX Runtime Web, MIT (`vendor/LICENSE-onnxruntime-web.txt`)

Model CLIP od OpenAI (MIT) ve formátu ONNX od [Xenova](https://huggingface.co/Xenova/clip-vit-base-patch32) se stahuje při prvním spuštění, v repozitáři není.
