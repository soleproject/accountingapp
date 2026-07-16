import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { ProductForm } from '../_components/ProductForm';
import { createProductAction } from '../_actions/products';

export default function NewBillingProductPage() {
  return (
    <AdminPage
      title="Add Billing Product"
      crumbs={[
        { label: 'SuperAdmin', href: '/super-admin/dashboard' },
        { label: 'Billing Products', href: '/super-admin/products' },
        { label: 'New' },
      ]}
    >
      <Panel className="p-5">
        <ProductForm action={createProductAction} submitLabel="Create Product" />
      </Panel>
    </AdminPage>
  );
}
