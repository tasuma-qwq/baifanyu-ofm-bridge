// Synthetic fixture, never a live availability claim.
export const catalog = {
  groups: [
    { id: 'qodercn', models: [
      { id: 'dfmodel', reasoning: { efforts: ['none', 'low', 'high', 'max'].map(id => ({ id })) } }
    ] },
    { id: 'trae', models: [
      { id: 'deepseek-v4.1-flash', reasoning: { efforts: ['light', 'high', 'extra_high'].map(id => ({ id })) } }
    ] }
  ]
};
