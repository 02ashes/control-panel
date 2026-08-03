'use strict';

var DAY1_THEORY = {
  id: 'day1-theory',
  version: 7,
  title: 'День 1 — база рабочего чата',
  modules: [
    {
      id: 'work-cycle',
      kicker: 'База · 2 минуты',
      title: 'Сначала контекст, потом живой голос',
      lead: 'В каждом задании отдельно указано, что известно о модели, фане и текущем разговоре. Бери из паст манеру общения, а факты — только из текущего условия.',
      points: [
        'Перед ответом посмотри последнюю реплику, карточку, заметки, прошлые покупки и доступный контент.',
        'Рабочий голос: нормальные слова вместо u/ur/rn/wanna, заглавная I, живые паузы через «...», иногда haha, :3 или >_<. Не лепи их в каждую строку.',
        'Возьми одну свежую деталь фана, отреагируй на неё и, если к месту, добавь один факт модели из условия. Потом задай один простой вопрос.',
        'Не пиши идеально отполированный мини-текст. Живое сообщение может начаться с Wait..., Well... или Omg... и немного недоговорить мысль.'
      ],
      rule: 'Деталь фана → живая реакция → если к месту, факт модели → один вопрос.',
      examples: [
        {
          label: 'Простой вопрос из реальной приветки',
          text: 'What are your hobbies?',
          tone: 'neutral'
        },
        {
          label: 'Fan',
          text: 'I make beats after work. Mostly hip-hop.',
          tone: 'neutral'
        },
        {
          label: 'Подстроили реальную пасту под его ответ',
          text: 'Okay, making beats after work actually sounds fun. Mine are pretty nerdy ngl... What do you use to make them? :3',
          tone: 'good'
        }
      ],
      media: [
        {
          src: '/onlyfans/Карточка фана.jpg',
          alt: 'Карточка фана со статистикой и заметками',
          caption: 'Карточка фана: сначала читаем, потом пишем',
          callouts: [
            'Смотри траты, среднюю сумму открытых платных сообщений (PPV) и дату последней активности.',
            'Заметки подсказывают прошлые договорённости и интересы.',
            'Цифры помогают выбрать подход, но не заменяют чтение самого чата.',
            'Внутренние цифры и заметки используем молча — фану их не цитируем.'
          ]
        },
        {
          src: '/onlyfans/Контент.jpg',
          alt: 'Раздел Vault с папками доступного контента',
          caption: 'Vault — библиотека готового контента',
          callouts: [
            'Папки показывают готовые темы, форматы и наборы.',
            'Сначала найди подходящий контент, только потом обещай его фану.',
            'Описание в сообщении должно совпадать с тем, что окажется внутри.'
          ]
        }
      ],
      check: {
        question: 'Вы уже обсудили имя Noah и Minnesota. Факт модели: скоро начнёт учиться sound design. Последняя фраза Noah: “And I make beats after work.” Какой ответ лучше продолжает свежую тему?',
        options: [
          'Noah... okay haha. I like that name. Have your friends always called you that? :3',
          'Omg... you make beats too. I am going to study sound design, so now I am curious haha. What kind of music? :3',
          'Omg... Minnesota. I will be there soon haha. Have you always lived there? :3'
        ],
        correctIndex: 1,
        explanation: 'Все три написаны в нужной манере. Второй сильнее: он цепляется за последнюю новую деталь, коротко связывает её с данным в условии sound design и задаёт один вопрос. Первый возвращается к уже закрытой теме имени, а третий — к Minnesota.'
      }
    },
    {
      id: 'lore-and-live-scene',
      kicker: 'Live-эффект · 2 минуты',
      title: 'Лор постоянный, сцена живая',
      lead: 'Лор держит образ модели целым. Сцена «делаю прямо сейчас» добавляет жизнь, если каждое действие логично продолжает чат.',
      points: [
        'Лор — постоянная основа: возраст, город, семья, характер, интересы, планы и уже рассказанные факты не меняются.',
        'Сначала выбери подходящий контент в Vault — библиотеке готовых фото и видео. Потом можно разыграть подготовку к нему: сменить помаду, поправить свет или выбрать позу.',
        'Выбор фана должен вызвать действие модели «прямо сейчас» и привести к подходящему медиа.',
        'Модель не объясняет фану эту технику. Она просто пишет, что делает сейчас, и не обещает формат, которого нет в Vault.'
      ],
      rule: 'Сначала медиа в Vault → потом сцена «прямо сейчас» → то же медиа.',
      examples: [
        {
          label: 'Лор этого примера',
          text: 'Model facts: from Moldova; won a talent visa; moving to Minnesota; will study sound design.',
          tone: 'neutral'
        },
        {
          label: 'Ответ использует только данный лор',
          text: 'I won a talent visa, so... Yes. And they offered me a free dorm and tuition',
          tone: 'good'
        },
        {
          label: 'Live-эффект в другом разговоре',
          text: 'Wait... Let me find the lipstick I want to use for your surprise. Give me one minute :3',
          tone: 'good'
        }
      ],
      check: {
        question: 'Фан выбрал красный образ. В Vault есть красные фото, но нет видео. Какой первый ответ лучше создаёт эффект «прямо сейчас» и не меняет оффер?',
        options: [
          'I have the red photos right here haha. Do you want me to send them before I change my mind? :3',
          'Wait... I want to make a little video in that look now. Give me one minute :3',
          'Red... okay haha. Let me find the lipstick I want to use for your surprise. One minute :3'
        ],
        correctIndex: 2,
        explanation: 'Все три звучат как сообщения, а не как учебник. Третий сильнее: помада создаёт маленькое действие прямо сейчас и спокойно ведёт к готовым фото. Первый раскрывает, что сет уже готов, а второй выдумывает отсутствующее видео.'
      }
    },
    {
      id: 'silent-fan',
      kicker: 'Молчун · 2 минуты',
      title: 'Молчун тоже отвечает',
      lead: 'Если фан читает и ставит реакции, тишина ещё не означает отказ. Просто дай ему способ общаться без текста.',
      points: [
        'Предложи одно простое действие: поставить лайк, выбрать emoji или отреагировать на один вариант.',
        'Давай один выбор за раз — без анкеты из нескольких вопросов.',
        'Увидел реакцию — сразу продолжи по выбранному варианту, не спрашивай то же самое ещё раз.',
        'Не упрекай за молчание и не заваливай сообщениями.'
      ],
      rule: 'Нет слов → просим минимальную реакцию → используем её как настоящий ответ.',
      examples: [
        {
          label: 'Контекст примера',
          text: 'Fan reads the messages and leaves likes, but does not type.',
          tone: 'neutral'
        },
        {
          label: 'Разрешаем ответить без текста',
          text: 'You can just like this if typing is not your thing. I will understand :3',
          tone: 'good'
        },
        {
          label: 'Лайк сразу становится ответом',
          text: 'Okayy, quiet mode haha. Can I call you Joe? Like this if that works :3',
          tone: 'good'
        }
      ],
      media: [
        {
          src: '/Молчуны/Лайкает соо.jpg',
          alt: 'Чат, в котором молчун отвечает лайками',
          caption: 'Реальный молчун: лайк становится его ответом',
          callouts: [
            'Сначала чаттер предлагает поставить лайк вместо текста.',
            'После первого сигнала фану дают понятные варианты.',
            'Выбранная реакция сразу двигает разговор дальше.',
            'Смотрим на механику ветки, а не копируем английский со скрина слово в слово.'
          ]
        }
      ],
      check: {
        question: 'Фан ничего не пишет, но поставил лайк на black outfit. Как лучше использовать его реакцию?',
        options: [
          'Okayy, black won haha. Give me one minute... I know which one I want to show you now :3',
          'I saw that like haha. What was it about the black one that got you? You can give me one word :3',
          'Okayy, I think that means black haha. Like this again so I know I understood you right :3'
        ],
        correctIndex: 0,
        explanation: 'Все три сохраняют рабочую манеру общения. Первый сильнее: «black won» принимает лайк как полноценный выбор и сразу продолжает ветку. Второй снова требует текст, а третий заставляет подтверждать уже сделанный выбор.'
      }
    },
    {
      id: 'soft-transition',
      kicker: 'Тон · 2 минуты',
      title: 'От обычного вопроса к личному',
      lead: 'В реальной приветке переход работает не через случайную сексуальную шутку. Сначала узнаём человека, затем просим разрешение на более личный вопрос.',
      points: [
        'Сначала имя, страна и один живой разговор про хобби. Это знакомство, а не анкета: реагируй на каждый ответ.',
        'После нормальной реакции спроси разрешение: «Can I ask you a more personal question?»',
        'Только после его «yes» задавай kink-вопрос про любимую категорию или фетиш. PH в реальной пасте означает Pornhub.',
        'Если вопрос сложный, упрости выбор, но не вытягивай ответ давлением.'
      ],
      rule: 'Его ответ → живая реакция → разрешение → ждём → один личный вопрос.',
      examples: [
        {
          label: 'После разговора о хобби',
          text: 'Honestly that sounds way more fun than my whole personality haha.. mine are pretty nerdy ngl',
          tone: 'good'
        },
        {
          label: 'Отдельный мост из приветки',
          text: 'And can I ask you a more personal question? :)',
          tone: 'good'
        },
        {
          label: 'Только после согласия',
          text: 'What is the one category you always end up searching for on PH? Or your fetish haha',
          tone: 'good'
        }
      ],
      check: {
        question: 'Fan: “I mostly cook and watch anime after work.” Модель уже ответила про свои хобби. Как лучше сделать первый шаг к более личной теме?',
        options: [
          'Anime? Omg... Okay, what are your top three right now? :3',
          'Anime? Omg... What is the one category you always search for on PH? :3',
          'Anime? Omg... Can I ask you a more personal question? :3'
        ],
        correctIndex: 2,
        explanation: 'Все три можно представить в живом чате. Третий отдельно просит разрешение перед личным вопросом. Первый остаётся в теме аниме, а второй уже задаёт интимный вопрос, не дождавшись согласия.'
      }
    },
    {
      id: 'offer-and-objection',
      kicker: 'Продажа · 2 минуты',
      title: 'Возражение не ломает разговор',
      lead: 'Если фан тормозит перед покупкой, модель не превращается в менеджера и не начинает торговаться. Сначала выясняем одну настоящую причину.',
      points: [
        'Перед отправкой сверь формат, количество, тему, особые детали и цену с реальным контентом.',
        'На расплывчатое «не сейчас» задай один короткий выбор: цена или слишком быстро.',
        'Если дело в цене, не спорь и не выдумывай скидку. Оставь платное сообщение на месте и перестань толкать его в этой сессии.',
        'Если слишком быстро, вернись к обычному разговору. Более дешёвый вариант можно дать только там, где он предусмотрен в воронке.'
      ],
      rule: 'Уточнил причину → ответил только на неё → не давишь повторно.',
      examples: [
        {
          label: 'Диагностика из реальной ветки',
          text: 'Okay... was it the price or did I move too quickly? You can give me one word',
          tone: 'neutral'
        },
        {
          label: 'Если причина в цене',
          text: 'I understand. Leave it there for now... I would rather you open it when you actually want to see what is behind that preview than because I kept poking you >_<',
          tone: 'good'
        },
        {
          label: 'Если всё случилось слишком быстро',
          text: 'That is fair haha. We can talk normally first. What did you actually want to know about me? :3',
          tone: 'good'
        }
      ],
      check: {
        question: 'Платное сообщение из приветственной воронки уже отправлено. Фан отвечает: “I don’t know... maybe not right now.” Какой ответ лучше всего выясняет причину и сохраняет живой голос?',
        options: [
          'Okay... maybe $15 was too much. I can make it a little cheaper tonight if you still want it >_<',
          'Wait... do you mean the price, or did I rush the whole thing? One word is enough :3',
          'That is fair haha. We can talk normally first. What did you actually want to know about me? :3'
        ],
        correctIndex: 1,
        explanation: 'Второй ответ не угадывает за фана: он даёт два понятных варианта и просит одно слово. Третий был бы правильным уже после ответа «too fast», а первый без разрешения меняет цену.'
      }
    },
    {
      id: 'custom-and-videocall',
      kicker: 'Крупный оффер · 2 минуты',
      title: 'Кастом и видеочат продаём через ценность',
      lead: 'В День 1 достаточно основы: идея должна ощущаться продолжением вашего разговора, а не рекламой, которую можно отправить любому.',
      points: [
        'Кастом — это персональное видео под запрос фана. Вернись к его интересу, напиши идею как живую мысль и сначала спроси, хочет ли он её услышать.',
        'После интереса раскрой мини-сцену с конкретными действиями, личной деталью и точными условиями.',
        'Допка к видеочату: назови дополнительное действие и простыми словами объясни, что фан получит от него.',
        'Не добавляй локацию, реквизит, длительность или техническую возможность, которых нет в условиях.'
      ],
      rule: 'Его интерес → мысль модели → конкретная сцена → точные условия и польза.',
      examples: [
        {
          label: 'Кастом начинается с его интереса',
          text: 'Wait... I remembered what you said about cooking and I got an idea haha. Can I tell you? :3',
          tone: 'good'
        },
        {
          label: 'Идея звучит как личная фантазия',
          text: 'So... I want to try making your favorite dish on camera and taste it for you when it is ready. What would you make me cook? :3',
          tone: 'good'
        },
        {
          label: 'Видеочат: польза, а не слово upgrade',
          text: 'Mmm... I can get ready before we start, so you will see more of me instead of losing half the call while I undress >_<',
          tone: 'good'
        }
      ],
      media: [
        {
          src: '/кастом/photo_2025-01-17_05-27-05 (2).jpg',
          alt: 'Реальный чат с идеей кастома через интерес к готовке',
          caption: 'Кастом: интерес фана превращается в личную сцену',
          callouts: [
            'Тема готовки появляется из самого разговора с фаном.',
            'Чаттер возвращается к его словам, а не достаёт случайную идею.',
            'Сценарий раскрывается через действия, а не сухое «хочешь кастом?».',
            'На День 1 берём принцип персонализации, а не копируем длинную пасту.'
          ]
        },
        {
          src: '/видеочат/photo_2025-04-09_21-28-49 (3).jpg',
          alt: 'Реальный чат с допродажами к видеозвонку',
          caption: 'Видеочат: каждая допка получает понятную ценность',
          callouts: [
            'Сначала согласован базовый звонок, затем предлагается отдельная допка.',
            'Подготовка заранее сохраняет оплаченные минуты фана.',
            'Вторая игрушка — ещё одно конкретное изменение опыта, а не пустая доплата.',
            'Скрин показывает логику ценности; точную формулировку новичок пишет сам.'
          ]
        }
      ],
      check: {
        question: 'Фан согласен на 10-минутный видеочат. База — одна игрушка. За $20 можно добавить вторую и полностью подготовиться до начала. Как лучше объяснить доплату?',
        options: [
          'Mmm... for $20 more I can get ready with the second toy before we start... then you do not lose any of your 10 mins waiting for me >_<',
          'Mmm... then for $20 more I can have the second toy ready too. I think it will make the whole call much hotter for both of us >_<',
          'Mmm... then for $20 more I can use the second toy and stay five minutes longer, so neither of us has to rush at the end >_<'
        ],
        correctIndex: 0,
        explanation: 'Первый вариант сохраняет живой голос, называет обе реальные части допки и объясняет пользу через его оплаченные минуты. Второй обещает только «hotter», но не объясняет конкретную пользу, а третий выдумывает дополнительные пять минут.'
      }
    }
  ]
};

if (typeof window !== 'undefined') {
  window.DAY1_THEORY = DAY1_THEORY;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DAY1_THEORY;
}
