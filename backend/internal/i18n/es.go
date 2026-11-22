package i18n

var spanish = Language{
	Code:    "es",
	BotCode: "es",
	Tags:    []string{"es"},
	Texts: Texts{
		Welcome:    "Incognito Chat permite que la gente te escriba de forma anónima, con cifrado de extremo a extremo. Abre la app para configurarla o para leer tus mensajes.",
		Open:       "Abrir Incognito Chat",
		Command:    "Abrir Incognito Chat",
		Notice:     "Nuevo mensaje",
		NoticeOpen: "Abrir",
		Description: "Mensajes anónimos, con cifrado de extremo a extremo. Cualquiera que tenga tu enlace puede escribirte sin que sepas quién es, y tú puedes responder. " +
			"Los mensajes se cifran en el dispositivo antes de enviarse: el servidor no puede leerlos y nunca registra quién escribió a quién.",
		About: "Mensajes anónimos a través de tu propio enlace, con cifrado de extremo a extremo.",
	},
}
