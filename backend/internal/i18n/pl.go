package i18n

var polish = Language{
	Code:    "pl",
	BotCode: "pl",
	Tags:    []string{"pl"},
	Texts: Texts{
		Welcome:    "Incognito Chat pozwala innym pisać do ciebie anonimowo, z szyfrowaniem end-to-end. Otwórz aplikację, aby ją skonfigurować lub przeczytać swoje wiadomości.",
		Open:       "Otwórz Incognito Chat",
		Command:    "Otwórz Incognito Chat",
		Notice:     "Nowa wiadomość",
		NoticeOpen: "Otwórz",
		Description: "Anonimowe wiadomości z szyfrowaniem end-to-end. Każdy, kto ma twój link, może do ciebie pisać, a ty możesz odpowiedzieć, nie wiedząc, kim jest. " +
			"Wiadomości są szyfrowane na urządzeniu przed wysłaniem: serwer nie może ich odczytać i nigdy nie zapisuje, kto do kogo pisał.",
		About: "Anonimowe wiadomości przez twój własny link, z szyfrowaniem end-to-end.",
	},
}
