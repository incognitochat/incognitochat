package i18n

var french = Language{
	Code:    "fr",
	BotCode: "fr",
	Tags:    []string{"fr"},
	Texts: Texts{
		Welcome:    "Incognito Chat permet à d'autres personnes de vous écrire anonymement, avec un chiffrement de bout en bout. Ouvrez l'application pour la configurer ou pour lire vos messages.",
		Open:       "Ouvrir Incognito Chat",
		Command:    "Ouvrir Incognito Chat",
		Notice:     "Nouveau message",
		NoticeOpen: "Ouvrir",
		Description: "Messages anonymes, chiffrés de bout en bout. Toute personne qui a votre lien peut vous écrire sans que vous sachiez qui elle est, et vous pouvez répondre. " +
			"Les messages sont chiffrés sur l'appareil avant d'être envoyés : le serveur ne peut pas les lire et n'enregistre jamais qui a écrit à qui.",
		About: "Messages anonymes via votre propre lien, chiffrés de bout en bout.",
	},
}
