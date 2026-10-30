import {describe,it,expect} from 'vitest';
import {effect,weeklyBalances} from '../src/services/balances.js';
describe('operational balance rules',()=>{it('uses independent exact weekly formulas',()=>expect(weeklyBalances(1000,100,50,20,300)).toEqual({current:950,net:730}));it('negative amounts reverse configured effects',()=>expect(effect(-125,-1)).toBe(125));it('no-effect multiplier leaves balance unchanged',()=>expect(effect(80,0)).toBe(0));});
