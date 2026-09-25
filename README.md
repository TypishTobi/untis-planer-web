# Untis Planer – Weboberfläche

Die Oberfläche des [Untis Planers](https://github.com/TypishTobi/untis-planer) für
den Browser. Läuft als statische Seite auf GitHub Pages, **ohne Server**.

## Was hier liegt – und was nicht

In diesem Repository stehen **nur** HTML, CSS und JavaScript. Es enthält keine
Termine, keine Notizen, keine Zugangsdaten.

Die Seite liest den Datenbestand zur Laufzeit aus einem **privaten** Repository:

| Quelle | Inhalt |
| --- | --- |
| Zweig `handy` → `Untis-Termine.json` | Termine und drei Wochen Stundenplan |
| Zweig `main` → `userdata.json` | Notizen, eigene Einträge, Einstellungen |

Ohne gültiges Token zeigt die Seite nichts an.

## Token

Die Seite fragt beim ersten Öffnen nach einem **fine-grained Personal Access
Token**, das nur für das eigene Daten-Repository gilt:

- Repository access: *Only select repositories* → das Daten-Repository
- Repository permissions → **Contents: Read and write**

Mehr Rechte braucht sie nicht. Das Token wird im `localStorage` des Browsers
abgelegt und ausschließlich an `api.github.com` geschickt – es verlässt das
Gerät sonst nicht und liegt nirgendwo in diesem Repository.

Unter „Zugang“ lässt es sich jederzeit wieder löschen.

## Schreiben

Geändert wird immer nach demselben Muster: frischen Stand holen, die eigene
Änderung hineinlegen, zurückschreiben. Hat in der Zwischenzeit ein PC etwas
abgelegt, geht es dabei nicht verloren.
