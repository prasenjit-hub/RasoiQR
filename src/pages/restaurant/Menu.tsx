import React, { useEffect, useState } from "react";
import { Plus, Edit, Trash2, Eye, EyeOff, Search, Package } from "lucide-react";
import {
  Card,
  Button,
  Input,
  Badge,
  Modal,
  Skeleton,
  Alert,
  Textarea,
  ImageUpload,
} from "../../components/ui";
import {
  subscribeToMenuItems,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  toggleMenuItemAvailability,
} from "../../services/restaurantService";
import type { MenuItem } from "../../config/supabase";
import { formatCurrency } from "../../utils/helpers";
import { useAuth } from "../../contexts/AuthContext";

const Menu: React.FC = () => {
  const { restaurant } = useAuth();
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  useEffect(() => {
    if (!restaurant) return;

    const cleanup = subscribeToMenuItems(restaurant.id, (data) => {
      setMenuItems(data);
      setLoading(false);
    });

    return cleanup;
  }, [restaurant]);

  const categories = [
    "all",
    ...new Set(menuItems.map((item) => item.category).filter(Boolean)),
  ];

  const filteredItems = menuItems.filter((item) => {
    const matchesSearch = item.name
      .toLowerCase()
      .includes(searchTerm.toLowerCase());
    const matchesCategory =
      categoryFilter === "all" || item.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  const handleToggleAvailability = async (item: MenuItem) => {
    await toggleMenuItemAvailability(item.id, !item.is_available);
  };

  const handleEdit = (item: MenuItem) => {
    setSelectedItem(item);
    setShowEditModal(true);
  };

  const handleDelete = (item: MenuItem) => {
    setSelectedItem(item);
    setShowDeleteModal(true);
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Skeleton className="h-8 w-48 mb-2" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-10 w-32 rounded-lg" />
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          <Skeleton className="h-11 flex-1 rounded-lg" />
          <Skeleton className="h-11 w-full sm:w-48 rounded-lg" />
        </div>
        <div className="grid gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i} className="flex flex-col lg:flex-row gap-4">
              <Skeleton className="w-full lg:w-32 h-48 lg:h-32 rounded-lg shrink-0" />
              <div className="flex-1 space-y-3">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-4 w-full max-w-md" />
                <div className="flex gap-4 mt-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-32" />
                </div>
              </div>
              <div className="flex flex-col sm:flex-row lg:flex-col gap-2 shrink-0 lg:min-w-[150px]">
                <Skeleton className="h-9 w-full rounded-md" />
                <Skeleton className="h-9 w-full rounded-md" />
                <Skeleton className="h-9 w-full rounded-md" />
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text mb-2">Menu Management</h2>
          <p className="text-text-secondary">
            Manage your menu items and availability
          </p>
        </div>
        <Button
          icon={<Plus className="w-5 h-5" />}
          onClick={() => setShowAddModal(true)}
        >
          Add Item
        </Button>
      </div>

      {/* Search and Filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <Input
            placeholder="Search menu items..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            icon={<Search className="w-5 h-5" />}
          />
        </div>
        <div className="w-full sm:w-48 shrink-0">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="w-full bg-white border border-border text-text rounded-lg px-4 py-2.5 font-medium focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-colors cursor-pointer appearance-none"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e")`,
              backgroundPosition: `right 0.5rem center`,
              backgroundRepeat: `no-repeat`,
              backgroundSize: `1.5em 1.5em`,
              paddingRight: `2.5rem`
            }}
          >
            {categories.map((category) => (
              <option key={category} value={category || "all"}>
                {category === "all" ? "All Categories" : category}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Menu Items */}
      {filteredItems.length === 0 ? (
        <Card className="text-center py-12">
          <Package className="w-16 h-16 text-text-secondary mx-auto mb-4 opacity-50" />
          <h3 className="text-xl font-semibold text-text mb-2">
            No Menu Items Found
          </h3>
          <p className="text-text-secondary mb-4">
            {searchTerm || categoryFilter !== "all"
              ? "Try adjusting your filters"
              : "Start by adding your first menu item"}
          </p>
          <Button
            icon={<Plus className="w-5 h-5" />}
            onClick={() => setShowAddModal(true)}
          >
            Add First Item
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4">
          {filteredItems.map((item) => (
            <Card
              key={item.id}
              className={`hover:shadow-lg transition-shadow ${
                !item.is_available ? "opacity-60" : ""
              }`}
            >
              <div className="flex flex-col lg:flex-row gap-4">
                {/* Image */}
                {item.image_url && (
                  <img
                    src={item.image_url}
                    alt={item.name}
                    className="w-full lg:w-32 h-48 lg:h-32 object-cover rounded-lg shrink-0"
                  />
                )}

                {/* Details */}
                <div className="flex-1 space-y-2 min-w-0">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <h3 className="text-lg font-bold text-text break-words">
                          {item.name}
                        </h3>
                        <Badge
                          variant={item.is_available ? "success" : "neutral"}
                          className="shrink-0"
                        >
                          {item.is_available ? "Available" : "Unavailable"}
                        </Badge>
                      </div>
                      {item.category && (
                        <Badge variant="neutral" className="text-xs">
                          {item.category}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {item.description && (
                    <p className="text-text-secondary text-sm break-words">
                      {item.description}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-4 text-sm mt-2">
                    <div>
                      <span className="text-text-secondary">Base Price: </span>
                      <span className="text-accent font-semibold text-lg">
                        {formatCurrency(item.base_price)}
                      </span>
                    </div>

                    {item.sizes && item.sizes.length > 0 && (
                      <div>
                        <span className="text-text-secondary">Sizes: </span>
                        <span className="text-text">
                          {item.sizes.map((s) => s.name).join(", ")}
                        </span>
                      </div>
                    )}

                    {item.addons && item.addons.length > 0 && (
                      <div>
                        <span className="text-text-secondary">Add-ons: </span>
                        <span className="text-text">
                          {item.addons.length} available
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col sm:flex-row lg:flex-col gap-2 shrink-0 lg:min-w-[150px] mt-4 lg:mt-0">
                  <Button
                    size="sm"
                    variant={item.is_available ? "outline" : "secondary"}
                    icon={
                      item.is_available ? (
                        <EyeOff className="w-4 h-4 shrink-0" />
                      ) : (
                        <Eye className="w-4 h-4 shrink-0" />
                      )
                    }
                    onClick={() => handleToggleAvailability(item)}
                    className="flex-1 sm:flex-none"
                  >
                    <span className="truncate">{item.is_available ? "Mark Unavailable" : "Mark Available"}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<Edit className="w-4 h-4 shrink-0" />}
                    onClick={() => handleEdit(item)}
                    className="flex-1 sm:flex-none"
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<Trash2 className="w-4 h-4 shrink-0" />}
                    onClick={() => handleDelete(item)}
                    className="flex-1 sm:flex-none"
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Add/Edit Modals */}
      <MenuItemModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        mode="add"
      />

      <MenuItemModal
        isOpen={showEditModal}
        item={selectedItem}
        onClose={() => {
          setShowEditModal(false);
          setSelectedItem(null);
        }}
        mode="edit"
      />

      {/* Delete Modal */}
      <DeleteModal
        isOpen={showDeleteModal}
        item={selectedItem}
        onClose={() => {
          setShowDeleteModal(false);
          setSelectedItem(null);
        }}
      />
    </div>
  );
};

// Menu Item Modal (Add/Edit)
interface MenuItemModalProps {
  isOpen: boolean;
  item?: MenuItem | null;
  onClose: () => void;
  mode: "add" | "edit";
}

const MenuItemModal: React.FC<MenuItemModalProps> = ({
  isOpen,
  item,
  onClose,
  mode,
}) => {
  const { restaurant } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    category: "",
    base_price: "",
    image_url: "",
    is_available: true,
    sizes: [] as { name: string; price: number }[],
    addons: [] as { name: string; price: number }[],
  });

  const [newSize, setNewSize] = useState({ name: "", price: "" });
  const [newAddon, setNewAddon] = useState({ name: "", price: "" });

  useEffect(() => {
    if (mode === "edit" && item) {
      setFormData({
        name: item.name,
        description: item.description || "",
        category: item.category || "",
        base_price: item.base_price.toString(),
        image_url: item.image_url || "",
        is_available: item.is_available,
        sizes: item.sizes || [],
        addons: item.addons || [],
      });
    } else {
      setFormData({
        name: "",
        description: "",
        category: "",
        base_price: "",
        image_url: "",
        is_available: true,
        sizes: [],
        addons: [],
      });
    }
  }, [mode, item, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!formData.name || !formData.base_price) {
      setError("Name and base price are required");
      return;
    }

    if (!restaurant) {
      setError("Restaurant session not loaded");
      return;
    }

    setLoading(true);

    const menuItemData: Record<string, unknown> = {
      restaurant_id: restaurant.id,
      name: formData.name,
      base_price: parseFloat(formData.base_price),
      is_available: formData.is_available,
      sizes: formData.sizes,
      addons: formData.addons,
    };
    if (formData.description) menuItemData.description = formData.description;
    if (formData.category) menuItemData.category = formData.category;
    if (formData.image_url) menuItemData.image_url = formData.image_url;

    let success = false;
    if (mode === "add") {
      success = await createMenuItem(menuItemData);
    } else if (item) {
      success = await updateMenuItem(item.id, menuItemData);
    }

    setLoading(false);

    if (success) {
      onClose();
    } else {
      setError(`Failed to ${mode} menu item`);
    }
  };

  const addSize = () => {
    if (newSize.name && newSize.price) {
      setFormData({
        ...formData,
        sizes: [
          ...formData.sizes,
          { name: newSize.name, price: parseFloat(newSize.price) },
        ],
      });
      setNewSize({ name: "", price: "" });
    }
  };

  const removeSize = (index: number) => {
    setFormData({
      ...formData,
      sizes: formData.sizes.filter((_, i) => i !== index),
    });
  };

  const addAddon = () => {
    if (newAddon.name && newAddon.price) {
      setFormData({
        ...formData,
        addons: [
          ...formData.addons,
          { name: newAddon.name, price: parseFloat(newAddon.price) },
        ],
      });
      setNewAddon({ name: "", price: "" });
    }
  };

  const removeAddon = (index: number) => {
    setFormData({
      ...formData,
      addons: formData.addons.filter((_, i) => i !== index),
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={mode === "add" ? "Add Menu Item" : "Edit Menu Item"}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && <Alert type="error" message={error} />}

        <Input
          label="Item Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder="e.g., Margherita Pizza"
          required
        />

        <Textarea
          label="Description (Optional)"
          value={formData.description}
          onChange={(e) =>
            setFormData({ ...formData, description: e.target.value })
          }
          placeholder="Describe your item..."
          rows={2}
        />

        <div className="grid sm:grid-cols-2 gap-4">
          <Input
            label="Category"
            value={formData.category}
            onChange={(e) =>
              setFormData({ ...formData, category: e.target.value })
            }
            placeholder="e.g., Pizza, Burgers"
          />

          <Input
            label="Base Price"
            type="number"
            step="0.01"
            value={formData.base_price}
            onChange={(e) =>
              setFormData({ ...formData, base_price: e.target.value })
            }
            placeholder="0.00"
            required
          />
        </div>

        <ImageUpload
          label="Item Image (Optional)"
          value={formData.image_url}
          onChange={(url) => setFormData({ ...formData, image_url: url })}
        />

        {/* Sizes */}
        <div>
          <label className="label mb-3">Sizes (Optional)</label>
          <div className="space-y-2 mb-3">
            {formData.sizes.map((size, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-3 bg-bg-subtle rounded-lg"
              >
                <span className="text-text">
                  {size.name} - {formatCurrency(size.price)}
                </span>
                <button
                  type="button"
                  onClick={() => removeSize(index)}
                  className="text-error hover:bg-error/10 p-1 rounded"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Size name"
              value={newSize.name}
              onChange={(e) => setNewSize({ ...newSize, name: e.target.value })}
            />
            <Input
              placeholder="Price"
              type="number"
              step="0.01"
              value={newSize.price}
              onChange={(e) =>
                setNewSize({ ...newSize, price: e.target.value })
              }
            />
            <Button type="button" onClick={addSize} variant="outline">
              Add
            </Button>
          </div>
        </div>

        {/* Add-ons */}
        <div>
          <label className="label mb-3">Add-ons (Optional)</label>
          <div className="space-y-2 mb-3">
            {formData.addons.map((addon, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-3 bg-bg-subtle rounded-lg"
              >
                <span className="text-text">
                  {addon.name} - +{formatCurrency(addon.price)}
                </span>
                <button
                  type="button"
                  onClick={() => removeAddon(index)}
                  className="text-error hover:bg-error/10 p-1 rounded"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Add-on name"
              value={newAddon.name}
              onChange={(e) =>
                setNewAddon({ ...newAddon, name: e.target.value })
              }
            />
            <Input
              placeholder="Price"
              type="number"
              step="0.01"
              value={newAddon.price}
              onChange={(e) =>
                setNewAddon({ ...newAddon, price: e.target.value })
              }
            />
            <Button type="button" onClick={addAddon} variant="outline">
              Add
            </Button>
          </div>
        </div>

        {/* Availability */}
        <label className="flex items-center space-x-2 cursor-pointer">
          <input
            type="checkbox"
            checked={formData.is_available}
            onChange={(e) =>
              setFormData({ ...formData, is_available: e.target.checked })
            }
            className="rounded border-border"
          />
          <span className="text-text">Available for ordering</span>
        </label>

        <div className="flex gap-3">
          <Button type="button" variant="outline" onClick={onClose} fullWidth>
            Cancel
          </Button>
          <Button type="submit" loading={loading} fullWidth>
            {mode === "add" ? "Add Item" : "Save Changes"}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

// Delete Modal
interface DeleteModalProps {
  isOpen: boolean;
  item: MenuItem | null;
  onClose: () => void;
}

const DeleteModal: React.FC<DeleteModalProps> = ({ isOpen, item, onClose }) => {
  const [loading, setLoading] = useState(false);

  const handleDelete = async () => {
    if (!item) return;

    setLoading(true);
    const success = await deleteMenuItem(item.id);
    setLoading(false);

    if (success) {
      onClose();
    }
  };

  if (!item) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Delete Menu Item" size="md">
      <div className="space-y-4">
        <Alert
          type="warning"
          message={`Are you sure you want to delete "${item.name}"? This action cannot be undone.`}
        />

        <div className="flex gap-3">
          <Button variant="outline" onClick={onClose} fullWidth>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleDelete}
            loading={loading}
            fullWidth
          >
            Delete Item
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default Menu;
