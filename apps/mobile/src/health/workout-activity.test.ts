import { describe, expect, it } from 'vitest'
import { humanizeWorkoutActivity } from './workout-activity'

describe('humanizeWorkoutActivity', () => {
  it('spells out HealthKit numeric activity codes', () => {
    expect(humanizeWorkoutActivity(37)).toBe('Running')
    expect(humanizeWorkoutActivity(13)).toBe('Cycling')
    expect(humanizeWorkoutActivity(20)).toBe('Functional Strength Training')
  })

  it('title-cases a camelCase string, in case the bridge sends the key instead of the number', () => {
    expect(humanizeWorkoutActivity('traditionalStrengthTraining')).toBe('Traditional Strength Training')
    expect(humanizeWorkoutActivity('running')).toBe('Running')
  })

  it('falls back to a generic label for anything unrecognized', () => {
    expect(humanizeWorkoutActivity(9999)).toBe('Workout')
    expect(humanizeWorkoutActivity(null)).toBe('Workout')
    expect(humanizeWorkoutActivity('')).toBe('Workout')
  })
})
