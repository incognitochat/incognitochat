package i18n

var german = Language{
	Code:    "de",
	BotCode: "de",
	Tags:    []string{"de"},
	Texts: Texts{
		Welcome:    "Mit Incognito Chat können dir Leute anonym schreiben, Ende-zu-Ende-verschlüsselt. Öffne die App, um sie einzurichten oder deine Nachrichten zu lesen.",
		Open:       "Incognito Chat öffnen",
		Command:    "Incognito Chat öffnen",
		Notice:     "Neue Nachricht",
		NoticeOpen: "Öffnen",
		Description: "Anonyme Nachrichten, Ende-zu-Ende-verschlüsselt. Alle, die deinen Link haben, können dir schreiben, ohne dass du weißt, wer sie sind, und du kannst antworten. " +
			"Nachrichten werden auf dem Gerät verschlüsselt, bevor sie gesendet werden: Der Server kann sie nicht lesen und zeichnet nie auf, wer wem geschrieben hat.",
		About: "Anonyme Nachrichten über deinen eigenen Link, Ende-zu-Ende-verschlüsselt.",
	},
}
