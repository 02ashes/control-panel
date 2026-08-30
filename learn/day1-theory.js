'use strict';

var DAY1_THEORY = {
  id: 'day1-theory',
  // Module ids did not change. Keeping v7 preserves the current cohort's
  // completed theory state and local draft namespace across the hotfix.
  version: 7,
  title: 'День 1 — база рабочего чата',
  subtitle: 'Шесть коротких тем перед письменным отбором',
  estimatedMinutes: '15–20',
  glossary: [
    { term: 'Лор', definition: 'Постоянные факты модели, которые нельзя менять от сообщения к сообщению.' },
    { term: 'Vault', definition: 'Библиотека реально доступных фото, видео и наборов.' },
    { term: 'PPV', definition: 'Платное закрытое сообщение с контентом.' },
    { term: 'Live-сцена', definition: 'Правдоподобное действие модели «прямо сейчас», которое ведёт к доступному контенту.' },
    { term: 'Кастом', definition: 'Контент, который снимается персонально под согласованные детали фана.' },
    { term: 'Допка', definition: 'Отдельное платное улучшение уже согласованного предложения.' }
  ],
  modules: [
    {
      id: 'work-cycle',
      kicker: 'База · 3 минуты',
      title: 'Сначала контекст, потом живой голос',
      lead: 'В каждом задании отдельно указано, что известно о модели, фане и текущем разговоре. Манеру общения бери из примеров, а факты — только из текущего условия.',
      points: [
        'Перед ответом посмотри последнюю реплику, карточку, заметки, прошлые покупки и доступный контент.',
        'Возьми одну свежую деталь фана, нормально отреагируй на неё и задай один простой вопрос. Не возвращайся к уже закрытой теме только потому, что под неё есть паста.',
        'Пиши понятными словами, ставь заглавную I и избегай менеджерского тона. Паузы, haha, :3 и >_< — необязательные оттенки, а не формула правильного ответа.',
        'Не копируй приветку слово в слово. Рабочих начал и последовательностей разговора может быть несколько.'
      ],
      rule: 'Свежая деталь → человеческая реакция → один лёгкий вопрос.',
      examples: [
        {
          label: 'Короткий вопрос из реальной приветки',
          text: 'What are your hobbies?',
          tone: 'neutral',
          sourceType: 'real'
        },
        {
          label: 'Ответ фана для учебной ситуации',
          text: 'I make beats after work. Mostly hip-hop.',
          tone: 'neutral',
          sourceType: 'training'
        },
        {
          label: 'Адаптация под свежую деталь',
          text: 'Making beats after work actually sounds fun. What do you use to make them?',
          tone: 'good',
          sourceType: 'adapted'
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
          'Noah is a really nice name. Have your friends always called you that, or is it just your profile name?',
          'You make beats after work? I am about to start sound design classes, so now I am curious. What kind of music do you make?',
          'Minnesota can get so cold in winter. Have you always lived there, or did you move there for work?'
        ],
        correctIndex: 1,
        explanation: 'Все варианты можно отправить, но второй отвечает на последнюю новую деталь, связывает её только с данным в условии фактом модели и даёт Noah лёгкий вопрос. Остальные возвращают уже закрытые темы.'
      }
    },
    {
      id: 'lore-and-live-scene',
      kicker: 'Live-эффект · 3 минуты',
      title: 'Лор постоянный, сцена живая',
      lead: 'Лор держит образ модели целым. Сцена «делаю прямо сейчас» добавляет жизнь, если действие правдоподобно и ведёт к реально доступному контенту.',
      points: [
        'Лор — постоянная основа: возраст, город, семья, характер, интересы, планы и уже рассказанные факты не меняются.',
        'Сначала выбери подходящий контент в Vault. Потом можно разыграть подготовку к нему: сменить помаду, поправить свет, подойти к зеркалу или выбрать позу.',
        'Выбор или комментарий фана должен вызвать действие модели «прямо сейчас» и привести к подходящему медиа.',
        'Не обещай видео, звук, имя, число файлов или другой формат, которого нет в условии.'
      ],
      rule: 'Доступное медиа → логичное действие сейчас → тот же оффер без новых обещаний.',
      examples: [
        {
          label: 'Лор учебного примера',
          text: 'Model facts: from Moldova; won a talent visa; moving to Minnesota; will study sound design.',
          tone: 'neutral',
          sourceType: 'training'
        },
        {
          label: 'Строка из реальной приветки',
          text: 'I won a talent visa, so... Yes. And they offered me a free dorm and tuition',
          tone: 'good',
          sourceType: 'real'
        },
        {
          label: 'Адаптированный live-переход',
          text: 'Give me a second. I want to find the lipstick that fits the red set before I show you.',
          tone: 'good',
          sourceType: 'adapted'
        }
      ],
      check: {
        question: 'Фан выбрал красный образ. В Vault есть красные фото, но нет видео. Какой первый ответ лучше создаёт эффект «прямо сейчас» и не меняет оффер?',
        options: [
          'I have the red photos right here. Do you want me to send the whole set before I change my mind?',
          'Red is a good choice. Let me make a quick video in that look now, and I will be right back.',
          'Red won. Give me a second to find the lipstick I want with that set before I show you.'
        ],
        correctIndex: 2,
        explanation: 'Третий вариант создаёт маленькое правдоподобное действие сейчас и ведёт к имеющимся фото. Первый сразу раскрывает, что набор готов, а второй обещает отсутствующее видео.'
      }
    },
    {
      id: 'silent-fan',
      kicker: 'Молчун · 2 минуты',
      title: 'Молчун тоже отвечает',
      lead: 'Если фан читает и ставит реакции, тишина ещё не означает отказ. Дай ему способ общаться без набора текста.',
      points: [
        'Предложи одно простое действие: поставить лайк, выбрать emoji или отреагировать на вариант.',
        'Давай один понятный выбор за раз, без анкеты из нескольких вопросов.',
        'Увидел реакцию — сразу продолжи по выбранному варианту, не проси подтвердить тот же выбор повторно.',
        'Не упрекай за молчание и не заваливай сообщениями.'
      ],
      rule: 'Нет слов → минимальная реакция → считаем её настоящим ответом.',
      examples: [
        {
          label: 'Контекст учебного примера',
          text: 'Fan reads the messages and leaves likes, but does not type.',
          tone: 'neutral',
          sourceType: 'training'
        },
        {
          label: 'Строка из реальной пасты',
          text: 'You can just like this if typing is not your thing. I will understand :3',
          tone: 'good',
          sourceType: 'real'
        },
        {
          label: 'Другой рабочий вариант',
          text: 'Tap the black heart if lingerie is your thing. No typing needed.',
          tone: 'good',
          sourceType: 'training'
        }
      ],
      media: [
        {
          src: '/Молчуны/Лайкает соо.jpg',
          alt: 'Чат, в котором молчун отвечает лайками',
          caption: 'Реальный молчун: лайк становится его ответом',
          callouts: [
            'Сначала чаттер предлагает поставить лайк вместо текста.',
            'После первого сигнала фану дают понятный вариант.',
            'Выбранная реакция сразу двигает разговор дальше.',
            'Берём механику ветки; английский со скрина не обязан быть идеальным шаблоном.'
          ]
        }
      ],
      check: {
        question: 'Фан ничего не пишет, но поставил лайк на black outfit. Как лучше использовать его реакцию?',
        options: [
          'Black won. Give me one minute, I know exactly which look I want to show you next.',
          'I saw your like on the black one. What exactly did you enjoy about it? One word is enough.',
          'I think that like means black. Tap this message again so I know I understood your choice correctly.'
        ],
        correctIndex: 0,
        explanation: 'Первый вариант принимает лайк как полноценный выбор и сразу двигает ветку. Второй снова требует текст, а третий заставляет подтверждать уже понятную реакцию.'
      }
    },
    {
      id: 'soft-transition',
      kicker: 'Тон · 3 минуты',
      title: 'Лёгкий флирт и личный вопрос — не одно и то же',
      lead: 'Лёгкий флирт может естественно вырасти из текущей темы. Перед прямым вопросом о порно, фетише или графической сексуальной фантазии сначала спроси разрешение и дождись ответа.',
      points: [
        'Suggestive-фраза про его pasta, твой oversized T-shirt или совместный movie может быть первым лёгким флиртом, если она продолжает разговор и оставляет фану выбор.',
        'Перед прямым kink-вопросом спроси: «Can I ask you a more personal question?» — и дождись yes.',
        'После согласия задай один понятный интимный вопрос. PH в реальной пасте означает Pornhub.',
        'Нет обязательного маршрута «имя → страна → хобби». Важно реагировать на то, что фан реально пишет, а не проводить анкету.'
      ],
      rule: 'Контекстный лёгкий флирт допустим сразу; explicit/kink-вопрос — только после разрешения.',
      examples: [
        {
          label: 'Учебный лёгкий флирт из контекста',
          text: 'An oversized T-shirt and your pasta sound dangerously close to a good night together. What sauce did you make?',
          tone: 'good',
          sourceType: 'training'
        },
        {
          label: 'Мост из реальной приветки',
          text: 'And can I ask you a more personal question? :)',
          tone: 'good',
          sourceType: 'real'
        },
        {
          label: 'Только после согласия',
          text: 'What is the one category you always end up searching for on PH? Or your fetish haha',
          tone: 'good',
          sourceType: 'real'
        }
      ],
      check: {
        question: 'Fan: “I mostly cook and watch anime after work.” Модель уже ответила про свои хобби. Как лучше сделать первый шаг именно к интимной теме?',
        options: [
          'Anime after work is a perfect reset. Which show are you watching right now, and would you recommend it?',
          'Cooking and anime sounds cute. What is the one porn category or fetish you always come back to?',
          'Cooking and anime sounds like a good night. Can I ask you something a little more personal?'
        ],
        correctIndex: 2,
        explanation: 'Третий вариант отдельно просит разрешение. Первый нормально продолжает обычную тему, но не делает нужный переход; второй уже задаёт kink-вопрос, не дождавшись согласия.'
      }
    },
    {
      id: 'offer-and-objection',
      kicker: 'Продажа · 3 минуты',
      title: 'Возражение не ломает разговор',
      lead: 'Если фан тормозит перед покупкой, не начинай спорить или автоматически сбивать цену. Сначала пойми, что именно его остановило.',
      points: [
        'Перед отправкой сверь формат, количество, тему, особые детали и цену с реальным контентом.',
        'На расплывчатое «не сейчас» задай один короткий выбор: дело в цене или ты слишком быстро перешёл к продаже.',
        'Если он просто назвал цену высокой, не спорь, не придумывай скидку и перестань толкать тот же оффер в этой сессии.',
        'Исключение: если фан сам прямо просит более дешёвый вариант и такой вариант указан в доступном контенте, можно спокойно предложить ровно один.'
      ],
      rule: 'Узнай причину → ответь только на неё → не дави и не выдумывай условия.',
      examples: [
        {
          label: 'Адаптированная диагностика',
          text: 'Was it the price, or did I move too quickly? One word is enough.',
          tone: 'neutral',
          sourceType: 'adapted'
        },
        {
          label: 'Если причина только в цене',
          text: 'I understand. Leave it there for now. I would rather you open it when you actually want it.',
          tone: 'good',
          sourceType: 'training'
        },
        {
          label: 'Если он сам просит дешевле',
          text: 'I do have a smaller three-photo feet teaser for $9. Would that fit tonight better?',
          tone: 'good',
          sourceType: 'training'
        }
      ],
      check: {
        question: 'Платное сообщение уже отправлено. Фан отвечает: “I don’t know... maybe not right now.” Какой ответ лучше выясняет причину, не додумывая её за него?',
        options: [
          'Maybe the price is the problem. I can make it cheaper tonight if you still want to see everything.',
          'Do you mean the price, or did I rush the whole thing? You can give me one word.',
          'That is fair. We can forget the offer and talk normally. What did you want to know about me?'
        ],
        correctIndex: 1,
        explanation: 'Второй ответ сначала выясняет причину. Третий подходит уже после ответа «too fast», а первый угадывает за фана и самовольно меняет цену.'
      }
    },
    {
      id: 'custom-and-videocall',
      kicker: 'Крупный оффер · 3 минуты',
      title: 'Кастом и видеочат продаём через ценность',
      lead: 'Идея должна ощущаться продолжением разговора. Этапы кастома отправляются по одному после реакции фана, а не пачкой из заготовленных сообщений.',
      points: [
        'Сначала вернись к интересу фана, коротко скажи, что появилась идея, и спроси, хочет ли он её услышать. Дождись ответа.',
        'После его интереса раскрой мини-сцену с конкретными действиями и личной деталью. Следующий этап отправляй только если он продолжает разговор.',
        'Затем назови точные формат, длительность, цену и задай один вопрос о заказе. В письменном задании эти этапы стоят на отдельных строках, но в реальном чате не уходят одним залпом.',
        'Для допки к видеочату назови, что именно добавляется, и объясни конкретную пользу для фана.'
      ],
      rule: 'Интерес → разрешение → сцена → точные условия. Каждый этап ждёт реакцию.',
      examples: [
        {
          label: 'Адаптация из реальной ветки',
          text: 'I remembered what you said about cooking and got an idea. Can I tell you?',
          tone: 'good',
          sourceType: 'adapted'
        },
        {
          label: 'После его «yes»',
          text: 'I want to make your carbonara on camera, look right at you when I taste it, and say your name when you tell me I did it right.',
          tone: 'good',
          sourceType: 'training'
        },
        {
          label: 'Видеочат: польза, а не слово upgrade',
          text: 'I can be fully ready before we start, so none of your ten minutes disappear while I get set up.',
          tone: 'good',
          sourceType: 'training'
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
            'Сценарий раскрывается действиями после интереса фана.',
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
            'Вторая игрушка — конкретное изменение опыта, а не пустая доплата.',
            'Скрин показывает логику ценности; цены и формулировки берём из текущего задания.'
          ]
        }
      ],
      check: {
        question: 'Фан согласен на 10-минутный видеочат. База — одна игрушка. За $20 можно добавить вторую и полностью подготовиться до начала. Как лучше объяснить доплату?',
        options: [
          'The extra $20 adds a second toy, and I will be ready before we start, so all ten minutes stay inside the actual call. Want that?',
          'For $20 more I can have the second toy ready too. It will make everything much hotter and more exciting for both of us. Want it?',
          'For $20 more I can use a second toy and stay five minutes longer, so neither of us has to rush at the end. Deal?'
        ],
        correctIndex: 0,
        explanation: 'Первый вариант называет обе реальные части допки и объясняет пользу через оплаченные минуты. Второй не объясняет конкретную выгоду, а третий выдумывает ещё пять минут.'
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
