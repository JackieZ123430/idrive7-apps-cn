# MGU Custom Apps en español

Original: https://github.com/cauliflowermossgrape/idrive7-apps · Guía completa (en inglés): [README.md](README.md)

Traducción al español: Rubén Ríos ([rubenrios](https://github.com/rubenrios))

Esta página explica solo lo propio de la versión en español. Todo lo demás (qué hace cada app,
requisitos, acceso root a la unidad, SDK de BMW, riesgos) está en el README principal y vale igual.

## Qué incluye

- **Todas las apps en español**: títulos, pestañas, botones, ajustes, mensajes y las páginas que dibuja
  cada app. Son unos 2600 textos en `kit/runtime/locales/es.tsv`.
- **Fuentes con tildes**: el paquete en español lleva sus propias versiones de las fuentes del kit
  (`label`, `bold`, `light` y `num`) con á, é, í, ó, ú, ü, ñ, ¿ y ¡ añadidas. Las letras que ya tenían
  quedan exactamente igual, así que un texto sin tildes ocupa lo mismo que en inglés.
- **Fechas en español en Service**: «15 de septiembre de 2027», «en 10 meses», «2 meses de retraso».
  Los nombres de los elementos de mantenimiento que da un iDrive en español («Líquido de frenos»…)
  se muestran tal cual los da el coche.
- **Plurales y abreviaturas**: «1 avería / 3 averías», «mín. 70», «máx. 7200», «hace 5 min».
- **Crédito de la traducción**: una línea discreta en una esquina y una fila en Ajustes, solo en el paquete en español.

La versión en inglés no cambia: sin `--language es` se genera exactamente lo mismo que antes.

## Generar los paquetes

Igual que el ruso o el coreano, cada paquete va en un solo idioma y no hay selector dentro de la app.
Se elige al generarlo con `--language es` (también vale `es-ES` o `es_ES`):

```sh
python3 kit/tools/build.py --language es              # todas las apps -> dist/<id>@<versión>-es.1.mgu
python3 kit/tools/build.py --language es redline      # solo una app
python3 kit/tools/make_kit.py --language es           # kit para el coche -> dist/mgu-custom-apps-es(.tar.gz)
```

(En Windows, `python` en lugar de `python3`.)

Para instalar el kit en el coche se usa `deploy/push-to-car.sh` o `deploy/push-to-car.ps1` como dice el
README principal, indicando el kit en español:

```sh
KIT=dist/mgu-custom-apps-es HU=root@<ip-de-la-unidad> PORT=22 KEY=~/.ssh/id_mgu deploy/push-to-car.sh check
KIT=dist/mgu-custom-apps-es HU=root@<ip-de-la-unidad> PORT=22 KEY=~/.ssh/id_mgu deploy/push-to-car.sh install
```

```powershell
powershell -ExecutionPolicy Bypass -File deploy\push-to-car.ps1 install -Key <ruta>\id_rsa -Ip <ip-de-la-unidad> -Kit dist\mgu-custom-apps-es.tar.gz
```

Instalar el paquete de otro idioma sustituye al anterior, como una actualización.

## Vista previa sin SDK

Sin el SDK de BMW se puede ver cómo queda en el PC (no genera nada instalable):

```sh
python3 kit/tools/build.py --language es --preview-only redline service
node kit/tools/preview.js dist/redline preview/es/redline wait=3 BTN_PAGE wait=1
node kit/tools/preview.js dist/service preview/es/service wait=3
```

## Lo que sigue en inglés

- Las **descripciones de averías** del Escáner de averías: la base de datos de textos es solo en inglés.
  Los estados, botones y mensajes del escáner sí están traducidos.
- Los **nombres propios y siglas**: BMW, M Vitals, eDrive, xDrive, HUD, DME, EGS, DSC, OBD, UDS…, los
  nombres de los temas de color y los episodios de Doom.
- Los **modos de conducción** (Sport, Comfort, Eco Pro, Hybrid…), escritos como en la app en inglés.
- Cualquier texto nuevo que aún no esté en el catálogo: se ve en inglés hasta que se añade.

## Corregir o ampliar la traducción

1. Edita `kit/runtime/locales/es.tsv` (una línea por texto: `inglés<TAB>español`; la clave inglesa no
   se toca). Los plurales llevan dos formas: `fault|faults<TAB>avería|averías`.
2. Genera el JSON y comprueba:

   ```sh
   python3 kit/tools/sync_locales.py es
   cd kit/tools && python3 test_es.py
   ```

3. Si la traducción usa un carácter que no está en las fuentes (el test lo dice), vuelve a generarlas.
   Hace falta Pillow **con raqm** (libraqm, libfribidi y libharfbuzz) y la fuente Ubuntu
   (`Ubuntu[wdth,wght].ttf`, paquete `fonts-ubuntu`):

   ```sh
   python3 kit/tools/bake_spanish.py /usr/share/fonts/truetype/ubuntu/Ubuntu[wdth,wght].ttf
   ```

   Sin raqm, Pillow redondea el ancho de las letras y el script se para, porque las fuentes no
   coincidirían con las inglesas.
