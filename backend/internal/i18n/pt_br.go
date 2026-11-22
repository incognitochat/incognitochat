package i18n

var portuguese = Language{
	Code:    "pt-BR",
	BotCode: "pt",
	Tags:    []string{"pt", "pt-br", "pt-pt"},
	Texts: Texts{
		Welcome:    "Com o Incognito Chat, as pessoas podem enviar mensagens anônimas para você, com criptografia de ponta a ponta. Abra o app para configurá-lo ou ler suas mensagens.",
		Open:       "Abrir Incognito Chat",
		Command:    "Abrir Incognito Chat",
		Notice:     "Nova mensagem",
		NoticeOpen: "Abrir",
		Description: "Mensagens anônimas, com criptografia de ponta a ponta. Qualquer pessoa com o seu link pode escrever para você sem que você saiba quem é, e você pode responder. " +
			"As mensagens são criptografadas no dispositivo antes de serem enviadas: o servidor não consegue lê-las e nunca registra quem escreveu para quem.",
		About: "Mensagens anônimas pelo seu próprio link, com criptografia de ponta a ponta.",
	},
}
