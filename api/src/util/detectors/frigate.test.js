jest.mock('../../constants/config', () => ({
  detect: () => ({
    MATCH: { CONFIDENCE: 60, MIN_AREA: 10000 },
    UNKNOWN: { CONFIDENCE: 40, MIN_AREA: 0 },
  }),
}));

jest.mock('../../constants', () => () => ({
  DETECTORS: {
    FRIGATE: {
      URL: 'http://frigate:5000',
      TIMEOUT: 15,
    },
  },
}));

const { normalize } = require('./frigate');

describe('frigate detector normalize', () => {
  it('maps a successful recognition response', () => {
    const results = normalize({
      camera: 'front-door',
      data: {
        success: true,
        score: 0.92,
        face_name: 'David',
        source: { width: 200, height: 200 },
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'david',
      confidence: 92,
      match: true,
      box: { top: 0, left: 0, width: 200, height: 200 },
    });
  });

  it('returns unknown when score is below unknown confidence', () => {
    const results = normalize({
      camera: 'front-door',
      data: {
        success: true,
        score: 0.2,
        face_name: 'David',
        source: { width: 200, height: 200 },
      },
    });

    expect(results[0].name).toBe('unknown');
    expect(results[0].match).toBe(false);
  });

  it('returns an empty list when recognition fails', () => {
    expect(
      normalize({
        camera: 'front-door',
        data: { success: false, message: 'Face recognition is not enabled.' },
      })
    ).toEqual([]);
  });
});
