import AdminLayout from "@/components/AdminLayout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { zodResolver } from "@hookform/resolvers/zod";
import { Edit2, Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

const novelSchema = z.object({
  title: z.string().min(1, "Title is required"),
  slug: z.string().min(1, "Slug is required"),
  author: z.string().optional(),
  description: z.string().optional(),
  coverImageUrl: z.string().url("Must be a valid URL").optional().or(z.literal("")),
  status: z.enum(["ongoing", "completed", "hiatus"]),
});

type NovelFormData = z.infer<typeof novelSchema>;

export default function AdminNovelsPage() {
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const { data: novels, isLoading, refetch } = trpc.admin.novels.list.useQuery();
  const createMutation = trpc.admin.novels.create.useMutation();

  const form = useForm<NovelFormData>({
    resolver: zodResolver(novelSchema),
    defaultValues: {
      title: "",
      slug: "",
      author: "",
      description: "",
      coverImageUrl: "",
      status: "ongoing",
    },
  });

  const onSubmit = async (data: NovelFormData) => {
    try {
      if (editingId) {
        toast.info("Novel editing not yet implemented");
      } else {
        await createMutation.mutateAsync(data);
        toast.success("Novel created successfully");
      }
      setIsOpen(false);
      form.reset();
      setEditingId(null);
      refetch();
    } catch (error) {
      toast.error("Failed to save novel");
    }
  };

  const handleEdit = (novel: any) => {
    setEditingId(novel.id);
    form.reset({
      title: novel.title,
      slug: novel.slug,
      author: novel.author || "",
      description: novel.description || "",
      coverImageUrl: novel.coverImageUrl || "",
      status: novel.status,
    });
    setIsOpen(true);
  };

  const handleClose = () => {
    setIsOpen(false);
    form.reset();
    setEditingId(null);
  };

  return (
    <AdminLayout title="Novel Management">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-3xl font-bold">Novels</h2>
            <p className="text-muted-foreground mt-1">
              Manage your novel catalog
            </p>
          </div>

          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="w-4 h-4" />
                Add Novel
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>
                  {editingId ? "Edit Novel" : "Create New Novel"}
                </DialogTitle>
                <DialogDescription>
                  {editingId
                    ? "Update the novel details below"
                    : "Fill in the details to create a new novel"}
                </DialogDescription>
              </DialogHeader>

              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(onSubmit)}
                  className="space-y-4"
                >
                  <FormField
                    control={form.control}
                    name="title"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Title</FormLabel>
                        <FormControl>
                          <Input placeholder="Novel title" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="slug"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Slug (URL-friendly name)</FormLabel>
                        <FormControl>
                          <Input placeholder="novel-title" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="author"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Author/Translator</FormLabel>
                        <FormControl>
                          <Input placeholder="Author name" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="description"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Description</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Novel description"
                            rows={4}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="coverImageUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Cover Image URL</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="https://example.com/cover.jpg"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="status"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Status</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          defaultValue={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="ongoing">Ongoing</SelectItem>
                            <SelectItem value="completed">
                              Completed
                            </SelectItem>
                            <SelectItem value="hiatus">Hiatus</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="flex gap-2 pt-4">
                    <Button
                      type="submit"
                      disabled={createMutation.isPending}
                    >
                      {editingId ? "Update" : "Create"}
                    </Button>
                    <Button type="button" variant="outline" onClick={handleClose}>
                      Cancel
                    </Button>
                  </div>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>

        {/* Novels List */}
        {isLoading ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Loading novels...</p>
          </div>
        ) : !novels || novels.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground mb-4">No novels yet</p>
            <Button onClick={() => setIsOpen(true)} variant="outline">
              Create your first novel
            </Button>
          </div>
        ) : (
          <div className="grid gap-4">
            {novels.map((novel: any) => (
              <div
                key={novel.id}
                className="border rounded-lg p-4 flex items-start justify-between hover:bg-muted/50 transition"
              >
                <div className="flex-1">
                  <h3 className="font-semibold text-lg">{novel.title}</h3>
                  <p className="text-sm text-muted-foreground">
                    by {novel.author || "Unknown"}
                  </p>
                  <p className="text-sm mt-2 line-clamp-2">
                    {novel.description || "No description"}
                  </p>
                  <div className="flex gap-2 mt-2">
                    <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded capitalize">
                      {novel.status}
                    </span>
                  </div>
                </div>

                <div className="flex gap-2 ml-4">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleEdit(novel)}
                  >
                    <Edit2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
