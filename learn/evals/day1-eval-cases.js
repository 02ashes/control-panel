'use strict';

// Human-authored calibration set. Loading this file never calls xAI.
// Each task has a strong answer, a critical near-miss, an obvious failure,
// and a valid answer whose style differs from the reference greeting.
const DAY1_EVAL_CASES = [
  {
    id: 'personalized_opener.good',
    taskId: 'personalized_opener',
    kind: 'good',
    answer: 'Ethan, liking two gym posts after a night shift is impressive. Do you still train right after work, or do you sleep first?',
    expected: { band: { label: 'strong', min: 85, max: 100 }, taskPass: true, criticalOk: true }
  },
  {
    id: 'personalized_opener.borderline',
    taskId: 'personalized_opener',
    kind: 'borderline',
    answer: 'Hey, how are you?',
    expected: {
      band: { label: 'critical-miss', min: 20, max: 59 },
      taskPass: false,
      criticalOk: false,
      criteria: {
        context_use: { min: 0, max: 1 },
        reply_hook: { min: 1, max: 2 },
        commercial_restraint: { min: 4, max: 4 },
        format_language: { min: 2, max: 4 }
      },
      feedback: {
        mustMentionAny: ['context_detail'],
        forbidden: ['persona_marker']
      }
    }
  },
  {
    id: 'personalized_opener.bad',
    taskId: 'personalized_opener',
    kind: 'bad',
    answer: 'Hey zero spender, stop wasting time and buy my $20 gym PPV now.',
    expected: { band: { label: 'hard-fail', min: 0, max: 20 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'personalized_opener.unusual',
    taskId: 'personalized_opener',
    kind: 'unusual',
    answer: 'A paramedic who lifts after work has better discipline than me. Legs or upper body after a night shift, Ethan?',
    expected: {
      band: { label: 'valid-alternative', min: 75, max: 100 },
      taskPass: true,
      criticalOk: true,
      stability: true,
      criteria: {
        context_use: { min: 3, max: 4 },
        reply_hook: { min: 3, max: 4 },
        fact_fidelity: { min: 3, max: 4 },
        commercial_restraint: { min: 4, max: 4 },
        format_language: { min: 3, max: 4 }
      },
      feedback: { forbidden: ['greeting_formula', 'persona_marker', 'forced_rewrite'] }
    }
  },

  {
    id: 'silent_fan.good',
    taskId: 'silent_fan',
    kind: 'good',
    answer: 'Joe, tap ❤️ for lingerie or 🦶 for feet. No words needed; I will follow your pick.',
    expected: { band: { label: 'strong', min: 85, max: 100 }, taskPass: true, criticalOk: true }
  },
  {
    id: 'silent_fan.borderline',
    taskId: 'silent_fan',
    kind: 'borderline',
    answer: 'Joe, I saw you like lingerie and feet. Tell me which one you prefer and why.',
    expected: { band: { label: 'critical-miss', min: 20, max: 59 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'silent_fan.bad',
    taskId: 'silent_fan',
    kind: 'bad',
    answer: 'Why do you keep ignoring me, Joe? Answer me and buy my $25 lingerie set.',
    expected: { band: { label: 'hard-fail', min: 0, max: 20 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'silent_fan.unusual',
    taskId: 'silent_fan',
    kind: 'unusual',
    answer: 'One tap decides it: black heart means lingerie, foot means feet. Your move, joe2894.',
    expected: {
      band: { label: 'valid-alternative', min: 75, max: 100 },
      taskPass: true,
      criticalOk: true,
      stability: true,
      criteria: {
        nonverbal_channel: { min: 4, max: 4 },
        interest_use: { min: 3, max: 4 },
        no_silence_pressure: { min: 4, max: 4 },
        commercial_restraint: { min: 4, max: 4 },
        format_language: { min: 3, max: 4 }
      },
      feedback: { forbidden: ['greeting_formula', 'persona_marker', 'forced_rewrite'] }
    }
  },

  {
    id: 'sexting_transition.good',
    taskId: 'sexting_transition',
    kind: 'good',
    answer: 'That shift sounds brutal, but pasta at the end is a solid reward. I am home in an oversized T-shirt trying to choose a movie.\nIf your pasta tastes as good as it sounds, I might trade you a movie pick for a bite. What did you make?',
    expected: { band: { label: 'strong', min: 85, max: 100 }, taskPass: true, criticalOk: true }
  },
  {
    id: 'sexting_transition.borderline',
    taskId: 'sexting_transition',
    kind: 'borderline',
    answer: 'Twelve hours at the hospital sounds exhausting. What kind of pasta did you make?\nI am at home in an oversized T-shirt choosing a movie. Which movie should I watch?',
    expected: { band: { label: 'critical-miss', min: 20, max: 59 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'sexting_transition.bad',
    taskId: 'sexting_transition',
    kind: 'bad',
    answer: 'Cool.\nSend me a nude and buy my sexting PPV so I can tell you exactly what I would do to you.',
    expected: { band: { label: 'hard-fail', min: 0, max: 20 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'sexting_transition.unusual',
    taskId: 'sexting_transition',
    kind: 'unusual',
    answer: 'Twelve hours at the hospital and you still cook? I am impressed. I am hiding in an oversized T-shirt with a movie list.\nNow I am wondering whether your pasta or you would be the better reason to stay in tonight. Which movie are we ruining?',
    expected: {
      band: { label: 'valid-alternative', min: 75, max: 100 },
      taskPass: true,
      criticalOk: true,
      stability: true,
      criteria: {
        context_response: { min: 3, max: 4 },
        reply_hook: { min: 3, max: 4 },
        flirt_bridge: { min: 3, max: 4 },
        boundary_control: { min: 3, max: 4 },
        format_facts_language: { min: 3, max: 4 }
      },
      feedback: { forbidden: ['permission_for_light_flirt', 'persona_marker', 'forced_rewrite'] }
    }
  },

  {
    id: 'fetish_personalization.good',
    taskId: 'fetish_personalization',
    kind: 'good',
    answer: 'At least you found one creator who read it. You like watching and being teased with exactly what you are missing.\nStay right there while I decide what you get to see first. Close-up or full view?',
    expected: { band: { label: 'strong', min: 85, max: 100 }, taskPass: true, criticalOk: true }
  },
  {
    id: 'fetish_personalization.borderline',
    taskId: 'fetish_personalization',
    kind: 'borderline',
    answer: 'I really did read your profile, Mark. I am different from those other creators. What would you like to talk about?',
    expected: { band: { label: 'critical-miss', min: 20, max: 59 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'fetish_personalization.bad',
    taskId: 'fetish_personalization',
    kind: 'bad',
    answer: 'I did not read it. You can dominate me instead, but only after you buy my $40 video.',
    expected: { band: { label: 'hard-fail', min: 0, max: 20 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'fetish_personalization.unusual',
    taskId: 'fetish_personalization',
    kind: 'unusual',
    answer: 'Then let me prove I read it: you stay on the other side and watch while I make sure you know what you are missing. Do you want a cruel tease or a slow one?',
    expected: { band: { label: 'valid-alternative', min: 75, max: 100 }, taskPass: true, criticalOk: true }
  },

  {
    id: 'ppv_pitch.good',
    taskId: 'ppv_pitch',
    kind: 'good',
    answer: 'Black lingerie. Your comment about my little crescent moon made me turn toward the mirror and trace it with one finger.\nThat gave me six photos just now, from the black lingerie to nude, with close-ups of the tattoo. Open them for $18?',
    expected: { band: { label: 'strong', min: 85, max: 100 }, taskPass: true, criticalOk: true }
  },
  {
    id: 'ppv_pitch.borderline',
    taskId: 'ppv_pitch',
    kind: 'borderline',
    answer: 'I am wearing black lingerie, and my little crescent moon is showing.\nI have six photos from lingerie to nude with tattoo close-ups for $18. Want to open them?',
    expected: {
      band: { label: 'critical-miss', min: 20, max: 59 },
      taskPass: false,
      criticalOk: false,
      stability: true,
      criteria: {
        content_accuracy: { min: 3, max: 4 },
        teaser_transition: { min: 0, max: 1 },
        price_offer: { min: 3, max: 4 },
        two_step_format: { min: 3, max: 4 }
      },
      feedback: { mustMentionAny: ['live_action'] }
    }
  },
  {
    id: 'ppv_pitch.bad',
    taskId: 'ppv_pitch',
    kind: 'bad',
    answer: 'I am naked and my star tattoo is on my shoulder.\nI made a custom video saying your name. Buy it for $12.',
    expected: { band: { label: 'hard-fail', min: 0, max: 20 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'ppv_pitch.unusual',
    taskId: 'ppv_pitch',
    kind: 'unusual',
    answer: 'You noticed the moon. I am in black lingerie, kneeling by my mirror now so the crescent catches the light while I take the last shot.\nSix just-taken photos, ending nude with close-ups of the hip tattoo, are locked for $18. Want to open them?',
    expected: { band: { label: 'valid-alternative', min: 75, max: 100 }, taskPass: true, criticalOk: true }
  },

  {
    id: 'price_objection.good',
    taskId: 'price_objection',
    kind: 'good',
    answer: 'I am glad you liked the close-ups, and I understand $30 is too much tonight. I have a new three-photo feet teaser for $9. Would that work better?',
    expected: { band: { label: 'strong', min: 85, max: 100 }, taskPass: true, criticalOk: true }
  },
  {
    id: 'price_objection.borderline',
    taskId: 'price_objection',
    kind: 'borderline',
    answer: 'I am glad you liked the close-ups, Ryan. I understand the budget, so we can just talk for now. How was your day?',
    expected: { band: { label: 'critical-miss', min: 20, max: 59 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'price_objection.bad',
    taskId: 'price_objection',
    kind: 'bad',
    answer: 'Buy the $35 custom feet video and I will secretly discount it to $20 if you pay outside the site.',
    expected: { band: { label: 'hard-fail', min: 0, max: 20 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'price_objection.unusual',
    taskId: 'price_objection',
    kind: 'unusual',
    answer: 'Fair. Since you liked those close-ups, the new stockings photo set keeps the same feet focus without repeating what you bought. It is $15. Should I send that one?',
    expected: {
      band: { label: 'valid-alternative', min: 75, max: 100 },
      taskPass: true,
      criticalOk: true,
      stability: true,
      criteria: {
        appropriate_offer: { min: 3, max: 4 },
        price_content_pair: { min: 4, max: 4 },
        relevance_and_hook: { min: 3, max: 4 },
        no_pressure_format: { min: 3, max: 4 }
      },
      feedback: { forbidden: ['cheaper_offer_forbidden', 'persona_marker', 'forced_rewrite'] }
    }
  },

  {
    id: 'custom_pitch.good',
    taskId: 'custom_pitch',
    kind: 'good',
    answer: 'I would take control in the kitchen, stir your carbonara while I tell you where to stand, then plate it and taste it looking into the camera.\nIt would be a personalized 3-minute kitchen video just for you, and I can say your name, Chris. It is $90. Do you want me to make it?',
    expected: { band: { label: 'strong', min: 85, max: 100 }, taskPass: true, criticalOk: true }
  },
  {
    id: 'custom_pitch.borderline',
    taskId: 'custom_pitch',
    kind: 'borderline',
    answer: 'I can make something very sexy and special just for you.\nIt would be a personalized 3-minute kitchen video for $90. Do you want to order it, Chris?',
    expected: { band: { label: 'critical-miss', min: 20, max: 59 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'custom_pitch.bad',
    taskId: 'custom_pitch',
    kind: 'bad',
    answer: 'I will do a live ten-minute bathroom call with you for $50.\nYou need to bring the camera and ingredients. Pay now.',
    expected: { band: { label: 'hard-fail', min: 0, max: 20 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'custom_pitch.unusual',
    taskId: 'custom_pitch',
    kind: 'unusual',
    answer: 'Then you are staying out of my kitchen until I call you in. I will stir your carbonara, plate it slowly, and tell you whether you earned a taste.\nI will look into the camera and say your name when I take the first bite.\nA personalized 3-minute kitchen video is $90. Should I make this one for you, Chris?',
    expected: {
      band: { label: 'valid-alternative', min: 75, max: 100 },
      taskPass: true,
      criticalOk: true,
      stability: true,
      criteria: {
        profile_personalization: { min: 3, max: 4 },
        scenario_actions: { min: 3, max: 4 },
        deliverable_accuracy: { min: 4, max: 4 },
        personal_exclusivity: { min: 3, max: 4 },
        price_close_format: { min: 3, max: 4 }
      },
      feedback: { forbidden: ['custom_stages_called_spam', 'persona_marker', 'forced_rewrite'] }
    }
  },

  {
    id: 'videocall_upsell.good',
    taskId: 'videocall_upsell',
    kind: 'good',
    answer: 'The extra $20 adds a second toy, and I will be fully ready before we start, so none of your ten paid minutes are lost to setup. Want me to add it?',
    expected: { band: { label: 'strong', min: 85, max: 100 }, taskPass: true, criticalOk: true }
  },
  {
    id: 'videocall_upsell.borderline',
    taskId: 'videocall_upsell',
    kind: 'borderline',
    answer: 'Because the upgrade will make our call much hotter and more fun. It is $20 extra. Do you want it?',
    expected: { band: { label: 'critical-miss', min: 20, max: 59 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'videocall_upsell.bad',
    taskId: 'videocall_upsell',
    kind: 'bad',
    answer: 'Pay $30 extra and I will make the call fifteen minutes with three toys. Stop being cheap and say yes.',
    expected: { band: { label: 'hard-fail', min: 0, max: 20 }, taskPass: false, criticalOk: false }
  },
  {
    id: 'videocall_upsell.unusual',
    taskId: 'videocall_upsell',
    kind: 'unusual',
    answer: 'You are paying $20 extra for two differences: the second toy and zero setup during your call. I will be ready before the clock starts, so all ten minutes stay yours. Add it?',
    expected: { band: { label: 'valid-alternative', min: 75, max: 100 }, taskPass: true, criticalOk: true }
  }
];

module.exports = DAY1_EVAL_CASES;
