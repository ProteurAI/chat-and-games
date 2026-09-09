# Chat & Games 💬🎲

Chat & Games – läuft komplett lokal auf deinem Rechner, keine Cloud, keine Kosten.

## Einmalige Einrichtung

1. Python 3.10+ muss installiert sein (`python --version` prüfen).
2. Abhängigkeiten installieren:
   ```powershell
   python -m pip install -r requirements.txt
   ```
3. Optional: `config.json` anpassen – dort steht das Zugangspasswort (`team_password`, Standard: `insta2026`), der Port und die Standard-Kanäle. Unbedingt vor dem echten Einsatz ändern!

## Starten

```powershell
.\start.ps1
```

Das Skript zeigt dir direkt die Adresse an, die deine Freunde im Browser eingeben müssen, z. B.:

```
http://192.168.1.42:8000
```

Lass das PowerShell-Fenster offen – wenn du es schließt, geht der Chat für alle offline (läuft ja auf deinem Rechner).

Alternativ manuell:
```powershell
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

## Wie andere draufkommen

1. Gleiches WLAN/Netzwerk wie dein Rechner.
2. Im Browser (auch am Handy) die angezeigte Adresse eingeben, z. B. `http://192.168.1.42:8000`.
3. Passwort eingeben, Namen wählen – fertig.

Falls sich die IP mal ändert (z. B. nach Router-Neustart): auf deinem Rechner erneut `.\start.ps1` ausführen, die aktuelle IP wird angezeigt. Wer öfter denselben Chat nutzen will, kann im Router eine **DHCP-Reservierung** für deinen Rechner einrichten, dann bleibt die IP dauerhaft gleich.

## Windows-Firewall freigeben (einmalig)

Damit andere im Netzwerk überhaupt auf deinen Rechner zugreifen dürfen, muss der Port (Standard `8000`) für eingehende Verbindungen freigegeben sein.

**Einfachster Weg:** Beim ersten Start fragt Windows automatisch per Popup "Windows-Firewall hat einige Funktionen von Python blockiert" – dort **"Zugriff zulassen"** für **private Netzwerke** anklicken.

**Falls das Popup nicht kommt / manuell nötig**, als Administrator in PowerShell:
```powershell
New-NetFirewallRule -DisplayName "Chat & Games" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
```

## Worauf du achten solltest, damit es zuverlässig läuft

- **Rechner darf nicht in den Standby/Sleep gehen**, solange der Chat laufen soll (Energieoptionen ggf. anpassen, "Nie in den Ruhezustand" während der Nutzung).
- **Nur im gleichen Netzwerk** erreichbar – kein Zugriff von unterwegs/mobilen Daten, das ist so gewollt (kein Internet-Hosting).
- Manche Gäste-WLANs isolieren Geräte voneinander (AP-Isolation) – dann funktioniert der Zugriff nicht. Nutzt das reguläre WLAN.
- Die Datenbank (`data/instachat.db`) und hochgeladene Bilder (`data/uploads/`) liegen lokal im Projektordner – bei Bedarf einfach sichern/kopieren.

## Features (v1)

- Zugang nur per Passwort + Namenswahl, kein offenes Sign-up
- Mehrere Kanäle, frei anlegbar
- Echtzeit-Textchat (WebSockets)
- Emoji-Reaktionen auf Nachrichten
- @Erwähnungen (visuell hervorgehoben)
- Bilder per Drag & Drop oder Datei-Auswahl, inline im Chat
- Umfragen (2–6 Optionen) mit Live-Ergebnis-Balken
- Wer-ist-online-Anzeige in der Seitenleiste
- Webcam-Snaps (Einmal-Ansicht) und Multiplayer-Minispiele (Pong, Tic-Tac-Toe, Light Cycles, Buzzer, Schiffe versenken, UNO, Mensch ärgere dich nicht)

Nicht enthalten (bewusst, siehe Anforderungen): GIF-Suche, "Nachricht des Tages", Video-/Sprachchat, SSO/E-Mail-Verifizierung, Verschlüsselung.
