'use strict';

const DAY1_V1 = {
  id: 'day1',
  slug: 'day1-v1',
  version: 1,
  // Keep v1.6 while the first production cohort is in progress so their
  // completed submissions and attempt history remain visible after deployment.
  rubricVersion: 'day1-v1.6',
  passingScore: 85,
  minimumTaskScore: 60,
  maxAttemptsPerTask: 2,
  title: 'День 1 — письменный отбор',
  subtitle: 'Проверка самостоятельного общения, персонализации и продаж на английском',
  instructions: 'Ответы пиши только на английском языке и строго от лица модели. Переводчик разрешён. Готовые сниппеты, ChatGPT, Grok и любые другие AI-инструменты запрещены. Разделяй три вещи: фиксированный лор нельзя менять; текущую сцену можно живо продолжать правдоподобными действиями «прямо сейчас»; свойства оффера — контент, формат, длительность и цена — нельзя выдумывать или менять. Соблюдай число сообщений и лимит слов в каждом задании.',
  voiceGuide: `The target working chat voice is warm, curious, slightly shy, and a little nerdy, but task execution matters more than copying one persona sample.
Use normal sentence case and always capitalize I. Prefer complete words instead of u, ur, rn, or wanna.
Natural pauses and starts such as Wait..., Well..., So..., Omg..., haha, :3, or >_< are optional. Never raise or lower a rating merely because one of these markers is present or absent.
Accept different openings, sentence rhythms, and question order when the answer uses the supplied context, sounds human, and completes the task. Never require the greeting sequence shown in theory.
Build around one concrete fan detail, one human reaction or thought, and one easy next question when the task calls for a question. Add lore only when it fits the conversation.
Do not reward generic babe/love language, customer-support phrasing, polished advertising copy, checklist prose, or text that explains its own sales technique.
Minor grammar roughness is allowed. Judge observable meaning, voice, and conversational rhythm, not exact imitation or marker counting.`,
  responseLanguage: 'en',
  translatorAllowed: true,
  snippetsAllowed: false,
  aiAllowed: false,
  tasks: [
    {
      id: 'personalized_opener',
      title: 'Первое сообщение по карточке фана',
      context: `Fan card:
Name: Ethan
Subscribed: today
Spent: $0
Profile: "Night-shift paramedic. Lakers fan. I train after work."
Activity: He liked two of the model's gym posts in the last 10 minutes and is online now.

Model facts:
She trains legs twice a week and posted a gym selfie today.`,
      prompt: 'Напиши одно первое сообщение Ethan на английском языке. Начни разговор, используя информацию выше, и закончи одним лёгким вопросом по выбранному контексту. Пока не предлагай и не продавай контент. Максимум 45 слов.',
      placeholder: 'One opening message in English...',
      maxWords: 45,
      minMessages: 1,
      maxMessages: 1
    },
    {
      id: 'silent_fan',
      title: 'Молчун: реакция без слов',
      context: `Joe has opened the model's last four messages but has never replied with words.
He has liked both lingerie and feet posts.
His username is joe2894.
He has not purchased anything yet.`,
      prompt: 'Напиши одно сообщение Joe на английском языке. Используй его интерес к lingerie или feet и дай ему конкретный способ отреагировать без печатного ответа. Не жалуйся на его молчание и пока не отправляй платное предложение. Максимум 35 слов.',
      placeholder: 'One message that can be answered without typing...',
      maxWords: 35,
      minMessages: 1,
      maxMessages: 1
    },
    {
      id: 'sexting_transition',
      title: 'Из обычного разговора во флирт',
      context: `Daniel: "Just finished a 12-hour shift at the hospital. Finally home making pasta. What are you doing?"

Fan card:
Daniel is a nurse and enjoys cooking.

Model facts:
She is at home in an oversized T-shirt, choosing a movie.
The conversation has not been sexual yet.`,
      prompt: 'Напиши ровно два сообщения на английском языке и раздели их переносом строки. В первом ответь Daniel и отреагируй на его сообщение. Во втором продолжи ту же тему лёгким suggestive-флиртом и закончи простым вопросом или выбором. Такой контекстный флирт не требует отдельного разрешения; прямой вопрос о kink или графическая сексуальная тема потребовали бы разрешения и здесь не нужны. Не продавай контент. Максимум 80 слов суммарно.',
      placeholder: 'Message 1\nMessage 2',
      maxWords: 80,
      minMessages: 2,
      maxMessages: 2
    },
    {
      id: 'fetish_personalization',
      title: 'Персонализация под фетиш',
      context: `Fan card:
Name: Mark
Profile: "Cuck. I like watching, being teased, and being told what I'm missing."

Mark's last message:
"Most creators never even read my profile."

The model has read his profile. No sale has been offered yet.`,
      prompt: 'Напиши одно или два сообщения Mark на английском языке. Отреагируй на его последнюю фразу, покажи конкретной деталью, что прочитал его профиль, дай ему согласованную роль наблюдателя и простой способ продолжить фантазию. Пока не предлагай платный контент. Максимум 80 слов.',
      placeholder: 'One or two personalized messages in English...',
      maxWords: 80,
      minMessages: 1,
      maxMessages: 2
    },
    {
      id: 'ppv_pitch',
      title: 'Подводка к персональному PPV',
      context: `Alex is already flirting.

Alex:
"That little hip tattoo is driving me crazy. What are you wearing right now?"

Fixed model lore (must stay consistent):
- her hip tattoo is a small crescent moon

Current live scene:
- she is at home in her bedroom
- she is wearing black lingerie
- Alex's message arrived while she was taking new photos
- she may react to his tattoo comment with an ordinary plausible action right now

Available locked offer (commercial details must stay exact):
- 6 photos taken just now
- black lingerie progressing to nude
- close-ups of the hip tattoo
- price: $18
- no video, audio, or custom name`,
      prompt: 'Напиши ровно два сообщения на английском языке и раздели их переносом строки. В первом ответь, что на модели, упомяни crescent moon и покажи одно логичное действие модели прямо сейчас, вызванное комментарием Alex. Во втором свяжи этот момент с шестью свежими фото и предложи открыть их за $18. Обычное действие в спальне можно придумать, но лор и состав оффера менять нельзя. Максимум 100 слов суммарно.',
      placeholder: 'Free teaser\nLocked-content pitch',
      maxWords: 100,
      minMessages: 2,
      maxMessages: 2
    },
    {
      id: 'price_objection',
      title: 'Возражение по цене',
      context: `Ryan bought a $12 feet set.

Ryan:
"I loved the close-ups, but $30 is too much for me tonight. Do you have anything cheaper?"

Available content:
- $9: three-photo feet teaser
- $15: stockings photo set
- $35: custom feet video
- both the $9 teaser and the $15 stockings set are new and do not duplicate Ryan's previous purchase
- discounts are not allowed`,
      prompt: 'Напиши один ответ Ryan на английском языке. Он сам попросил вариант дешевле, поэтому спокойно признай его бюджет и предложи ровно один подходящий продукт из списка без новой скидки. Закончи простым вопросом-подтверждением именно об этом оффере. Максимум 60 слов.',
      placeholder: 'One reply with one appropriate offer...',
      maxWords: 60,
      minMessages: 1,
      maxMessages: 1
    },
    {
      id: 'custom_pitch',
      title: 'Кастом под интерес клиента',
      context: `Fan card:
Name: Chris
He has followed the model for five months.

Chris:
"Cooking is my thing. Carbonara is my best dish, and I love when a woman takes control in the kitchen."

The model asked if he wanted to hear an idea.
Chris replied:
"Yeah, tell me."

Available custom:
- one personalized 3-minute video
- filmed in the kitchen
- the model can say Chris's name
- price: $90`,
      prompt: 'Напиши черновик следующих двух или трёх этапов предложения на английском языке, каждый с новой строки. Представь, что в реальном чате каждая строка отправляется отдельно и только после того, как Chris продолжает проявлять интерес, а не одним залпом. Используй его cooking/carbonara и любовь к контролю, раскрой мини-сценарий минимум с двумя конкретными действиями, точно назови формат, длительность и цену, затем спроси, хочет ли он заказать такой кастом. Максимум 120 слов суммарно.',
      placeholder: 'Two or three messages pitching the custom...',
      maxWords: 120,
      minMessages: 2,
      maxMessages: 3
    },
    {
      id: 'videocall_upsell',
      title: 'Допка к видеочату',
      context: `Leo agreed to a 10-minute video call for $50.
He has said that toys are his favorite.
The base call includes one toy.

Available upgrade:
- a second toy
- the model will be fully ready before the call starts, so none of his 10 minutes are spent waiting
- additional price: $20

Leo:
"Why should I pay extra?"`,
      prompt: 'Напиши один ответ Leo на английском языке. Ответь на его вопрос, объясни конкретную ценность допки, назови дополнительную цену и закончи спокойным вопросом-подтверждением без клянченья. Максимум 55 слов.',
      placeholder: 'One concise reply explaining the upgrade...',
      maxWords: 55,
      minMessages: 1,
      maxMessages: 1
    }
  ]
};

module.exports = DAY1_V1;
