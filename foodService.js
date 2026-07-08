const foods = require('./foods');

function getMealsByCategory(category) {
  if (!category) return [];
  return foods.filter(f => f.category === category);
}

function getRandomMeals(meals, count = 5) {
  if (!Array.isArray(meals)) return [];
  const copy = meals.slice();
  const result = [];
  while (result.length < count && copy.length > 0) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

function buildMealReplies(meals, prefix = '') {
  if (!Array.isArray(meals)) return [];
  const replies = [];
  replies.push({ type: 'text', body: `${prefix}Here are some tasty options for you 👇` });

  for (let i = 0; i < meals.length; i++) {
    const m = meals[i];
    replies.push({
      type: 'image',
      imageUrl: m.image,
      caption: `${prefix}${i + 1}. ${m.name} — ${m.description}`
    });
  }

  return replies;
}

module.exports = { getMealsByCategory, getRandomMeals, buildMealReplies };
