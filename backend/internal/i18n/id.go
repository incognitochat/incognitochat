package i18n

// Some systems still send Indonesian's old code, "in".
var indonesian = Language{
	Code:    "id",
	BotCode: "id",
	Tags:    []string{"id", "in"},
	Texts: Texts{
		Welcome:    "Dengan Incognito Chat, orang bisa mengirim pesan kepada Anda secara anonim, dengan enkripsi end-to-end. Buka aplikasinya untuk menyiapkan akun atau membaca pesan Anda.",
		Open:       "Buka Incognito Chat",
		Command:    "Buka Incognito Chat",
		Notice:     "Pesan baru",
		NoticeOpen: "Buka",
		Description: "Pesan anonim dengan enkripsi end-to-end. Siapa pun yang punya tautan Anda bisa menulis kepada Anda tanpa Anda tahu siapa dia, dan Anda bisa membalasnya. " +
			"Pesan dienkripsi di perangkat sebelum dikirim: server tidak bisa membacanya dan tidak pernah mencatat siapa menulis kepada siapa.",
		About: "Pesan anonim lewat tautan pribadi Anda, dengan enkripsi end-to-end.",
	},
}
