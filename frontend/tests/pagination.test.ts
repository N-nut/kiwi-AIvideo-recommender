import { mount } from '@vue/test-utils';
import { describe,it,expect } from 'vitest';
import CatalogPagination from '../src/components/CatalogPagination.vue';
import { pageNumbers } from '../src/pagination';

describe('direct numbered pagination',()=>{
  it.each([
    [1,1,[1]], [1,5,[1,2,3,4,5]], [1,37,[1,2,3,'gap-3',37]],
    [18,37,[1,'gap-1',17,18,19,'gap-19',37]], [37,37,[1,'gap-1',35,36,37]],
  ])('shows a compact window at page %i of %i',(page,pages,expected)=>{
    expect(pageNumbers(page as number,pages as number)).toEqual(expected);
  });
  it('supports direct page clicks, updates the current page and never makes ellipses actionable',async()=>{
    const wrapper=mount(CatalogPagination,{props:{page:1,pages:37}});
    expect(wrapper.find('[aria-current=page]').text()).toBe('1');expect(wrapper.find('[aria-label="上一页"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[aria-label="第 37 页"]').trigger('click');expect(wrapper.emitted('change')).toEqual([[37]]);
    await wrapper.setProps({page:18});expect(wrapper.find('[aria-current=page]').text()).toBe('18');expect(wrapper.findAll('.page-ellipsis')).toHaveLength(2);
    await wrapper.find('[aria-label="下一页"]').trigger('click');expect(wrapper.emitted('change')?.at(-1)).toEqual([19]);
    expect(wrapper.findAll('.page-ellipsis').every(e=>e.element.tagName==='SPAN')).toBe(true);wrapper.unmount();
  });
  it('disables navigation during requests and hides the control for one page',async()=>{
    const wrapper=mount(CatalogPagination,{props:{page:37,pages:37,busy:true}});
    expect(wrapper.findAll('button').every(b=>b.attributes('disabled')!==undefined)).toBe(true);
    await wrapper.setProps({pages:1,page:1,busy:false});expect(wrapper.find('nav').exists()).toBe(false);wrapper.unmount();
  });
});
