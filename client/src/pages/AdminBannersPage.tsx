import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { ImageIcon, Trash2, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { useState, type ChangeEvent } from "react";

const ALLOWED_BANNER_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BANNER_IMAGE_SIZE = 5 * 1024 * 1024;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target?.result as string);
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

export default function AdminBannersPage() {
  const { user, isAuthenticated } = useAuth();

  const [isCreating, setIsCreating] = useState(false);
  const [selectedImageFile, setSelectedImageFile] = useState<File | null>(null);
  const [selectedImageDataUrl, setSelectedImageDataUrl] = useState("");

  const [formData, setFormData] = useState({
    title: "",
    description: "",
    linkUrl: "",
    displayOrder: 0,
  });

  const resetCreateForm = () => {
    setFormData({
      title: "",
      description: "",
      linkUrl: "",
      displayOrder: 0,
    });
    setSelectedImageFile(null);
    setSelectedImageDataUrl("");
  };

  const {
    data: banners,
    isLoading,
    refetch,
  } = trpc.admin.banners.list.useQuery(undefined, {
    enabled: !!user && user.role === "admin",
  });

  const uploadImageMutation = trpc.admin.banners.uploadImage.useMutation();

  const createMutation = trpc.admin.banners.create.useMutation({
    onSuccess: () => {
      toast.success("Banner created!");
      resetCreateForm();
      setIsCreating(false);
      refetch();
    },
  });

  const deleteMutation = trpc.admin.banners.delete.useMutation({
    onSuccess: () => {
      toast.success("Banner deleted");
      refetch();
    },
    onError: () => {
      toast.error("Failed to delete banner");
    },
  });

  // Now perform auth checks after all hooks are declared
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Please log in to access admin</p>
            <Button asChild>
              <a href="/">Go Home</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (user?.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Admin access required</p>
            <Button asChild>
              <a href="/">Go Home</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleImageChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      setSelectedImageFile(null);
      setSelectedImageDataUrl("");
      return;
    }

    if (!ALLOWED_BANNER_IMAGE_TYPES.includes(file.type)) {
      toast.error("Please upload a JPG, PNG, or WebP image");
      setSelectedImageFile(null);
      setSelectedImageDataUrl("");
      event.target.value = "";
      return;
    }

    if (file.size > MAX_BANNER_IMAGE_SIZE) {
      toast.error("Banner image must be 5MB or smaller");
      setSelectedImageFile(null);
      setSelectedImageDataUrl("");
      event.target.value = "";
      return;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      setSelectedImageFile(file);
      setSelectedImageDataUrl(dataUrl);
    } catch (error) {
      console.error("Image preview error:", error);
      toast.error("Failed to read image file");
      setSelectedImageFile(null);
      setSelectedImageDataUrl("");
      event.target.value = "";
    }
  };

  const handleCreate = async () => {
    if (!formData.title.trim() || !selectedImageFile || !selectedImageDataUrl) {
      toast.error("Title and banner image are required");
      return;
    }

    try {
      const uploadResult = await uploadImageMutation.mutateAsync({
        fileName: selectedImageFile.name,
        mimeType: selectedImageFile.type as "image/jpeg" | "image/png" | "image/webp",
        fileBase64: selectedImageDataUrl,
      });

      await createMutation.mutateAsync({
        ...formData,
        title: formData.title.trim(),
        description: formData.description.trim() || undefined,
        linkUrl: formData.linkUrl.trim() || undefined,
        imageUrl: uploadResult.url,
      });
    } catch (error: any) {
      console.error("Create banner error:", error);
      toast.error(error?.message || "Failed to create banner");
    }
  };

  const isSubmitting = uploadImageMutation.isPending || createMutation.isPending;

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Manage Banners</h1>

          <Button
            onClick={() => {
              if (isCreating) resetCreateForm();
              setIsCreating(!isCreating);
            }}
          >
            <Plus className="w-4 h-4 mr-2" />
            New Banner
          </Button>
        </div>

        {isCreating && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>Create New Banner</CardTitle>
            </CardHeader>

            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-semibold">Title</label>
                <Input
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="Banner title"
                />
              </div>

              <div>
                <label className="text-sm font-semibold">Description</label>
                <Input
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Banner description"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-semibold">Banner Image</label>

                <div className="rounded-lg border border-dashed border-slate-300 bg-white p-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                    <div className="flex h-32 w-full items-center justify-center overflow-hidden rounded-md bg-slate-100 sm:w-56">
                      {selectedImageDataUrl ? (
                        <img
                          src={selectedImageDataUrl}
                          alt="Banner preview"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <ImageIcon className="h-10 w-10 text-slate-400" />
                      )}
                    </div>

                    <div className="flex-1 space-y-2">
                      <Input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={handleImageChange}
                      />

                      <p className="text-xs text-slate-500">
                        Upload JPG, PNG, or WebP. Maximum file size 5MB.
                      </p>

                      {selectedImageFile && (
                        <p className="text-xs text-slate-700">
                          Selected: {selectedImageFile.name}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <label className="text-sm font-semibold">Link URL (optional)</label>
                <Input
                  value={formData.linkUrl}
                  onChange={(e) => setFormData({ ...formData, linkUrl: e.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div>
                <label className="text-sm font-semibold">Display Order</label>
                <Input
                  type="number"
                  value={formData.displayOrder}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      displayOrder: parseInt(e.target.value) || 0,
                    })
                  }
                />
              </div>

              <div className="flex gap-2 pt-4">
                <Button onClick={handleCreate} disabled={isSubmitting} className="flex-1">
                  <Upload className="w-4 h-4 mr-2" />
                  {isSubmitting ? "Uploading..." : "Create Banner"}
                </Button>

                <Button
                  variant="outline"
                  onClick={() => {
                    resetCreateForm();
                    setIsCreating(false);
                  }}
                  disabled={isSubmitting}
                  className="flex-1"
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : !banners || banners.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center py-12">
              <p className="text-slate-600">No banners yet</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {banners.map((banner: any) => (
              <Card key={banner.id} className="overflow-hidden">
                <CardContent className="pt-6">
                  <div className="flex gap-4">
                    {banner.imageUrl && (
                      <img
                        src={banner.imageUrl}
                        alt={banner.title}
                        className="w-32 h-24 object-cover rounded"
                      />
                    )}
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-900">{banner.title}</h3>
                      <p className="text-sm text-slate-600 mt-1">{banner.description}</p>
                      {banner.linkUrl && (
                        <p className="text-xs text-blue-600 mt-2">{banner.linkUrl}</p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteMutation.mutate({ bannerId: banner.id })}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
